#define _GNU_SOURCE
#include "osumania_session.h"
#include "osumania_vendor.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/input.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define KEYBOARD_SCAN 64
#define SCAN_PERIOD_MS 1000
#define HIST_LIMIT_US 1000
#define KEYBOARD_QUEUE_CAPACITY 1024

struct keyboard_report {
    uint8_t data[8];
    struct timespec since;
};

static volatile sig_atomic_t running = 1, snapshot_requested;
static uint64_t histogram[HIST_LIMIT_US + 2]; /* final bucket is >1000 us */
static uint64_t keyboard_reports, keyboard_dropped;
static int keyboard = -1, gadget_keyboard = -1, gadget_vendor = -1;
static int configured_keyboard = -1;
static uint8_t pressed[256], last_keyboard[8];
static struct keyboard_report keyboard_queue[KEYBOARD_QUEUE_CAPACITY];
static unsigned keyboard_queue_head, keyboard_queue_count;
static bool desynchronized, gadget_resync;
static _Atomic(struct osum_session *) mania_session;
static _Atomic(struct osum_vendor *) vendor_service;

struct service_args {
    const char *srs_path;
    const char *signer_backend;
};

static void on_signal(int sig)
{
    if (sig == SIGUSR1) snapshot_requested = 1;
    else running = 0;
}

static uint64_t elapsed_us(const struct timespec *start, const struct timespec *end)
{
    int64_t ns = (int64_t)(end->tv_sec - start->tv_sec) * 1000000000LL +
                 end->tv_nsec - start->tv_nsec;
    return ns < 0 ? 0 : (uint64_t)ns / 1000;
}

/* An on-demand snapshot, never called in the input-to-gadget dispatch path. */
static void snapshot(void)
{
    FILE *f = fopen("/run/bridge-daemon.stats.tmp", "w");
    if (!f) { perror("stats open"); return; }
    struct osum_session_status session_status;
    osum_session_status(atomic_load_explicit(&mania_session, memory_order_acquire),
                        &session_status);
    fprintf(f, "keyboard_reports %llu\nkeyboard_dropped %llu\n"
               "session_state %u\nsession_error %u\nsession_events %u\n",
            (unsigned long long)keyboard_reports, (unsigned long long)keyboard_dropped,
            (unsigned)session_status.state, (unsigned)session_status.last_error,
            session_status.event_count);
    for (size_t i = 0; i < sizeof(histogram)/sizeof(histogram[0]); i++)
        if (histogram[i]) fprintf(f, "keyboard_app_us_bucket_%zu %llu\n", i,
                                  (unsigned long long)histogram[i]);
    if (fclose(f) || rename("/run/bridge-daemon.stats.tmp", "/run/bridge-daemon.stats"))
        perror("stats snapshot");
}

static const uint8_t linux_to_hid[KEY_MAX + 1] = {
    [KEY_A]=4,[KEY_B]=5,[KEY_C]=6,[KEY_D]=7,[KEY_E]=8,[KEY_F]=9,[KEY_G]=10,
    [KEY_H]=11,[KEY_I]=12,[KEY_J]=13,[KEY_K]=14,[KEY_L]=15,[KEY_M]=16,
    [KEY_N]=17,[KEY_O]=18,[KEY_P]=19,[KEY_Q]=20,[KEY_R]=21,[KEY_S]=22,
    [KEY_T]=23,[KEY_U]=24,[KEY_V]=25,[KEY_W]=26,[KEY_X]=27,[KEY_Y]=28,[KEY_Z]=29,
    [KEY_1]=30,[KEY_2]=31,[KEY_3]=32,[KEY_4]=33,[KEY_5]=34,[KEY_6]=35,
    [KEY_7]=36,[KEY_8]=37,[KEY_9]=38,[KEY_0]=39,[KEY_ENTER]=40,[KEY_ESC]=41,
    [KEY_BACKSPACE]=42,[KEY_TAB]=43,[KEY_SPACE]=44,[KEY_MINUS]=45,[KEY_EQUAL]=46,
    [KEY_LEFTBRACE]=47,[KEY_RIGHTBRACE]=48,[KEY_BACKSLASH]=49,[KEY_SEMICOLON]=51,
    [KEY_APOSTROPHE]=52,[KEY_GRAVE]=53,[KEY_COMMA]=54,[KEY_DOT]=55,[KEY_SLASH]=56,
    [KEY_CAPSLOCK]=57,[KEY_F1]=58,[KEY_F2]=59,[KEY_F3]=60,[KEY_F4]=61,
    [KEY_F5]=62,[KEY_F6]=63,[KEY_F7]=64,[KEY_F8]=65,[KEY_F9]=66,
    [KEY_F10]=67,[KEY_F11]=68,[KEY_F12]=69,[KEY_SYSRQ]=70,[KEY_SCROLLLOCK]=71,
    [KEY_PAUSE]=72,[KEY_INSERT]=73,[KEY_HOME]=74,[KEY_PAGEUP]=75,[KEY_DELETE]=76,
    [KEY_END]=77,[KEY_PAGEDOWN]=78,[KEY_RIGHT]=79,[KEY_LEFT]=80,[KEY_DOWN]=81,
    [KEY_UP]=82,[KEY_NUMLOCK]=83,[KEY_KPSLASH]=84,[KEY_KPASTERISK]=85,
    [KEY_KPMINUS]=86,[KEY_KPPLUS]=87,[KEY_KPENTER]=88,[KEY_KP1]=89,
    [KEY_KP2]=90,[KEY_KP3]=91,[KEY_KP4]=92,[KEY_KP5]=93,[KEY_KP6]=94,
    [KEY_KP7]=95,[KEY_KP8]=96,[KEY_KP9]=97,[KEY_KP0]=98,[KEY_KPDOT]=99,
    [KEY_102ND]=100,[KEY_COMPOSE]=101,[KEY_POWER]=102,[KEY_KPEQUAL]=103,
    [KEY_F13]=104,[KEY_F14]=105,[KEY_F15]=106,[KEY_F16]=107,
    [KEY_F17]=108,[KEY_F18]=109,[KEY_F19]=110,[KEY_F20]=111,
    [KEY_F21]=112,[KEY_F22]=113,[KEY_F23]=114,[KEY_F24]=115,
    [KEY_RO]=135,[KEY_KATAKANAHIRAGANA]=136,[KEY_YEN]=137,[KEY_HENKAN]=138,
    [KEY_MUHENKAN]=139,[KEY_KPJPCOMMA]=140,
};

static int modifier(unsigned code)
{
    switch (code) {
    case KEY_LEFTCTRL: return 0; case KEY_LEFTSHIFT: return 1;
    case KEY_LEFTALT: return 2; case KEY_LEFTMETA: return 3;
    case KEY_RIGHTCTRL: return 4; case KEY_RIGHTSHIFT: return 5;
    case KEY_RIGHTALT: return 6; case KEY_RIGHTMETA: return 7;
    default: return -1;
    }
}

static void send_keyboard(const struct timespec *since);

static void release_keyboard(void)
{
    memset(pressed, 0, sizeof(pressed));
    last_keyboard[0] = 0xff; /* force all-key-up even if a press is pending */
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    send_keyboard(&now);
}

static void enqueue_keyboard(const uint8_t report[8], const struct timespec *since)
{
    if (keyboard_queue_count == KEYBOARD_QUEUE_CAPACITY) {
        keyboard_dropped += keyboard_queue_count;
        keyboard_queue_head = 0;
        keyboard_queue_count = 0;
    }
    unsigned slot = (keyboard_queue_head + keyboard_queue_count) % KEYBOARD_QUEUE_CAPACITY;
    memcpy(keyboard_queue[slot].data, report, sizeof(keyboard_queue[slot].data));
    keyboard_queue[slot].since = *since;
    keyboard_queue_count++;
}

static void record_keyboard_latency(const struct timespec *since)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    uint64_t us = elapsed_us(since, &now);
    histogram[us > HIST_LIMIT_US ? HIST_LIMIT_US + 1 : us]++;
    keyboard_reports++;
}

static void flush_keyboard(void)
{
    if (!keyboard_queue_count) return;
    struct keyboard_report *queued = &keyboard_queue[keyboard_queue_head];
    ssize_t n = write(gadget_keyboard, queued->data, sizeof(queued->data));
    if (n == sizeof(queued->data)) {
        record_keyboard_latency(&queued->since);
        keyboard_queue_head = (keyboard_queue_head + 1) % KEYBOARD_QUEUE_CAPACITY;
        keyboard_queue_count--;
    } else if (n >= 0 || errno != EAGAIN) {
        keyboard_dropped++;
        keyboard_queue_head = (keyboard_queue_head + 1) % KEYBOARD_QUEUE_CAPACITY;
        keyboard_queue_count--;
    }
}

static void send_keyboard(const struct timespec *since)
{
    uint8_t report[8] = {0};
    int count = 0;
    for (unsigned usage = 4; usage < 256; usage++) {
        if (!pressed[usage]) continue;
        if (usage >= 224 && usage <= 231) report[0] |= (uint8_t)(1U << (usage-224));
        else if (count < 6) report[2 + count++] = (uint8_t)usage;
        else count++;
    }
    if (count > 6) memset(report + 2, 1, 6);
    if (!memcmp(report, last_keyboard, sizeof(report))) return;
    memcpy(last_keyboard, report, sizeof(report));
    if (keyboard_queue_count) {
        enqueue_keyboard(report, since);
        return;
    }
    ssize_t n = write(gadget_keyboard, report, sizeof(report));
    if (n == sizeof(report)) record_keyboard_latency(since);
    else if (n < 0 && errno == EAGAIN) enqueue_keyboard(report, since);
    else keyboard_dropped++;
}

static bool is_usb_keyboard(int fd, unsigned event_number)
{
    char path[128], link[PATH_MAX];
    snprintf(path, sizeof(path), "/sys/class/input/event%u/device", event_number);
    if (!realpath(path, link)) return false;
    /* HID bus 0003 is USB. Evdev parent is normally input/inputN below HID. */
    bool usb = false;
    for (;;) {
        char *slash = strrchr(link, '/');
        if (!slash) break;
        if (!strncmp(slash + 1, "0003:", 5)) { usb = true; break; }
        *slash = '\0';
    }
    if (!usb) return false;
    unsigned long bits[(KEY_MAX + 1 + sizeof(long)*8-1)/(sizeof(long)*8)] = {0};
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(bits)), bits) < 0) return false;
    return (bits[KEY_A/(sizeof(long)*8)] & (1UL << (KEY_A%(sizeof(long)*8)))) &&
           (bits[KEY_ENTER/(sizeof(long)*8)] & (1UL << (KEY_ENTER%(sizeof(long)*8))));
}

static void discover_keyboard(void)
{
    if (keyboard >= 0) return;
    for (unsigned i = 0; i < KEYBOARD_SCAN; i++) {
        if (configured_keyboard >= 0 && (int)i != configured_keyboard) continue;
        char path[64];
        snprintf(path, sizeof(path), "/dev/input/event%u", i);
        int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        if (!is_usb_keyboard(fd, i)) { close(fd); continue; }
        int clock_id = CLOCK_MONOTONIC;
        if (ioctl(fd, EVIOCSCLOCKID, &clock_id) < 0) {
            fprintf(stderr, "%s: cannot select monotonic timestamps: %s\n", path, strerror(errno));
            close(fd); continue;
        }
        keyboard = fd;
        memset(pressed, 0, sizeof(pressed));
        desynchronized = false;
        fprintf(stderr, "keyboard source: %s (USB evdev)\n", path);
        return;
    }
}

static void keyboard_disconnected(void)
{
    if (keyboard >= 0) close(keyboard);
    keyboard = -1;
    keyboard_dropped += keyboard_queue_count;
    keyboard_queue_head = 0;
    keyboard_queue_count = 0;
    osum_session_input_lost(atomic_load_explicit(&mania_session, memory_order_acquire),
                            OSUM_INVALID_EVENT);
    release_keyboard();
    fprintf(stderr, "keyboard disconnected; released keys\n");
}

static void resync_keyboard(void)
{
    unsigned long keys[(KEY_MAX + 1 + sizeof(long)*8-1)/(sizeof(long)*8)] = {0};
    if (ioctl(keyboard, EVIOCGKEY(sizeof(keys)), keys) < 0) {
        keyboard_disconnected(); return;
    }
    memset(pressed, 0, sizeof(pressed));
    for (unsigned code = 0; code <= KEY_MAX; code++) {
        if (!(keys[code/(sizeof(long)*8)] & (1UL << (code%(sizeof(long)*8))))) continue;
        int mod = modifier(code);
        if (mod >= 0) pressed[224 + mod] = 1;
        else if (linux_to_hid[code]) pressed[linux_to_hid[code]] = 1;
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    send_keyboard(&now);
}

static int mania_lane(unsigned code)
{
    switch (code) {
    case KEY_D: return 0;
    case KEY_F: return 1;
    case KEY_J: return 2;
    case KEY_K: return 3;
    default: return -1;
    }
}
static void keyboard_input(void)
{
    /* At most 32 events per wake; input_event is read atomically from evdev. */
    for (int i = 0; i < 32; i++) {
        struct input_event event;
        ssize_t n = read(keyboard, &event, sizeof(event));
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
        if (n != sizeof(event)) { keyboard_disconnected(); return; }
        if (event.type == EV_SYN && event.code == SYN_DROPPED) {
            osum_session_input_lost(atomic_load_explicit(&mania_session, memory_order_acquire),
                                    OSUM_INVALID_EVENT);
            desynchronized = true;
            continue;
        }
        if (desynchronized) {
            if (event.type == EV_SYN && event.code == SYN_REPORT) {
                desynchronized = false;
                resync_keyboard();
            }
            continue;
        }
        if (event.type != EV_KEY || event.code > KEY_MAX || event.value == 2) continue;
        int mod = modifier(event.code);
        unsigned usage = mod >= 0 ? (unsigned)(224 + mod) : linux_to_hid[event.code];
        if (!usage || (event.value != 0 && event.value != 1)) continue;
        pressed[usage] = (uint8_t)event.value;
        int lane = mania_lane(event.code);
        if (lane >= 0) {
            const uint64_t timestamp_us = (uint64_t)event.time.tv_sec * 1000000u +
                                          (uint64_t)event.time.tv_usec;
            if (!osum_vendor_edge(atomic_load_explicit(&vendor_service, memory_order_acquire),
                                  timestamp_us, (uint8_t)lane, event.value ? 0u : 1u))
                osum_session_input_lost(atomic_load_explicit(&mania_session, memory_order_acquire),
                                        OSUM_EVENT_OVERFLOW);
            osum_session_capture_edge(
                atomic_load_explicit(&mania_session, memory_order_acquire),
                (uint8_t)lane, event.value ? 0u : 1u);
        }
        struct timespec received = { .tv_sec = event.time.tv_sec, .tv_nsec = event.time.tv_usec * 1000L };
        send_keyboard(&received);
    }
}


static void *start_vendor_service(void *opaque)
{
    const struct service_args *args = opaque;
    struct osum_session *session = osum_session_create(args->srs_path,
                                                       args->signer_backend);
    if (!session) {
        fprintf(stderr, "session allocation failed; keyboard forwarding remains active\n");
        return NULL;
    }
    struct osum_vendor *service = osum_vendor_start(gadget_vendor, session);
    if (!service) {
        fprintf(stderr, "Vendor HID worker failed; keyboard forwarding remains active\n");
        osum_session_destroy(session);
        return NULL;
    }
    atomic_store_explicit(&vendor_service, service, memory_order_release);
    atomic_store_explicit(&mania_session, session, memory_order_release);
    return NULL;
}

static int parse_keyboard(const char *value)
{
    if (!strcmp(value, "auto")) return -1;
    unsigned num;
    char tail;
    if (sscanf(value, "/dev/input/event%u%c", &num, &tail) == 1 && num < KEYBOARD_SCAN)
        return (int)num;
    fprintf(stderr, "--keyboard expects auto or /dev/input/eventN (N < %d)\n", KEYBOARD_SCAN);
    exit(2);
}


int main(int argc, char **argv)
{
    int priority = 60, cpu = -1;
    const char *srs_path = NULL;
    const char *signer_backend = "optee";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--keyboard") && i + 1 < argc)
            configured_keyboard = parse_keyboard(argv[++i]);
        else if (!strcmp(argv[i], "--srs") && i + 1 < argc)
            srs_path = argv[++i];
        else if (!strcmp(argv[i], "--signer") && i + 1 < argc)
            signer_backend = argv[++i];
        else if (!strcmp(argv[i], "--rt-priority") && i + 1 < argc) {
            char *end;
            long value = strtol(argv[++i], &end, 10);
            if (*end || value < 1 || value > 99) { fprintf(stderr, "invalid RT priority\n"); return 2; }
            priority = (int)value;
        } else if (!strcmp(argv[i], "--cpu") && i + 1 < argc) {
            char *end;
            long value = strtol(argv[++i], &end, 10);
            if (*end || value < 0 || value >= CPU_SETSIZE) { fprintf(stderr, "invalid CPU\n"); return 2; }
            cpu = (int)value;
        } else {
            fprintf(stderr, "usage: %s [--keyboard auto|/dev/input/eventN] [--srs FILE] [--signer optee|dev-insecure] [--rt-priority 1..99] [--cpu N]\n", argv[0]);
            return 2;
        }
    }
    gadget_keyboard = open("/dev/hidg0", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (gadget_keyboard < 0) { perror("/dev/hidg0"); return 1; }
    gadget_vendor = open("/dev/hidg1", O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (gadget_vendor < 0) { perror("/dev/hidg1"); return 1; }
    struct sigaction action = {.sa_handler = on_signal};
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
    sigaction(SIGUSR1, &action, NULL);
    struct service_args service_args = {srs_path, signer_backend};
    pthread_t service_initializer;
    if (pthread_create(&service_initializer, NULL, start_vendor_service, &service_args) == 0)
        pthread_detach(service_initializer);
    else
        fprintf(stderr, "Vendor service initializer failed; keyboard forwarding remains active\n");
    discover_keyboard();
    if (cpu >= 0) {
        cpu_set_t mask;
        CPU_ZERO(&mask); CPU_SET(cpu, &mask);
        if (sched_setaffinity(0, sizeof(mask), &mask)) { perror("RT sched_setaffinity"); return 1; }
    }
    /* Fail rather than silently advertise RT operation without memory lock or scheduling. */
    struct rlimit limit = {RLIM_INFINITY, RLIM_INFINITY};
    if (setrlimit(RLIMIT_MEMLOCK, &limit) || mlockall(MCL_CURRENT | MCL_FUTURE)) {
        perror("RT mlockall/setrlimit"); return 1;
    }
    volatile char prefault[32768];
    for (size_t i = 0; i < sizeof(prefault); i += 4096) prefault[i] = 0;
    struct sched_param policy = {.sched_priority = priority};
    if (sched_setscheduler(0, SCHED_FIFO, &policy) < 0) {
        perror("RT sched_setscheduler"); return 1;
    }
    FILE *ready = fopen("/run/bridge-daemon.ready", "w");
    if (!ready) { perror("ready marker"); return 1; }
    fprintf(ready, "%ld\n", (long)getpid());
    if (fclose(ready)) { perror("ready marker"); return 1; }
    fprintf(stderr, "RT FIFO priority %d; memory locked; keyboard forwarding active\n", priority);
    time_t next_discovery = 0;
    while (running) {
        struct pollfd fds[] = {
            {gadget_keyboard, POLLIN | ((keyboard_queue_count || gadget_resync) ? POLLOUT : 0), 0},
            {keyboard, POLLIN, 0}
        };
        int result = poll(fds, 2, SCAN_PERIOD_MS);
        if (result < 0 && errno != EINTR) { perror("poll"); break; }
        if (snapshot_requested) { snapshot_requested = 0; snapshot(); }
        if (fds[0].revents & POLLIN) {
            uint8_t leds[8];
            ssize_t n = read(gadget_keyboard, leds, sizeof(leds));
            /* LED output can't be mapped to arbitrary keyboards via evdev. */
            if (n > 0) { /* Explicitly ignored, documented in runtime notes. */ }
        }
        if (fds[0].revents & POLLOUT) {
            if (gadget_resync) {
                struct timespec now;
                keyboard_dropped += keyboard_queue_count;
                keyboard_queue_head = 0;
                keyboard_queue_count = 0;
                gadget_resync = false;
                last_keyboard[0] = 0xff;
                clock_gettime(CLOCK_MONOTONIC, &now);
                send_keyboard(&now);
            } else {
                flush_keyboard();
            }
        }
        if (fds[1].revents & POLLIN) keyboard_input();
        if (keyboard >= 0 && (fds[1].revents & (POLLHUP | POLLERR | POLLNVAL))) keyboard_disconnected();
        if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) {
            keyboard_dropped += keyboard_queue_count;
            keyboard_queue_head = 0;
            keyboard_queue_count = 0;
            gadget_resync = true;
            usleep(10000);
        }
        if (keyboard < 0) {
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            if (now.tv_sec >= next_discovery) {
                next_discovery = now.tv_sec + 1;
                discover_keyboard();
            }
        }
    }
    release_keyboard();
    snapshot();
    struct osum_vendor *service = atomic_exchange_explicit(&vendor_service, NULL,
                                                            memory_order_acq_rel);
    struct osum_session *session = atomic_exchange_explicit(&mania_session, NULL,
                                                             memory_order_acq_rel);
    osum_vendor_stop(service);
    osum_session_destroy(session);
    close(gadget_vendor);
    close(gadget_keyboard);
    unlink("/run/bridge-daemon.ready");
    return 0;
}
