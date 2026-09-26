#!/bin/sh
# Run ON the physical appliance; never manufacture samples when no board exists.
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: $0 OUTPUT_DIR [DURATION_SECONDS]" >&2; exit 2
fi
OUT=$1
DURATION=${2:-60}
case "$DURATION" in ''|*[!0-9]*) echo 'duration must be integer seconds' >&2; exit 2 ;; esac
[ "$DURATION" -gt 0 ] || { echo 'duration must be positive' >&2; exit 2; }
LOAD=${BRIDGE_BENCH_LOAD:-idle}
case "$LOAD" in idle|stress) ;; *) echo 'BRIDGE_BENCH_LOAD must be idle or stress' >&2; exit 2 ;; esac
if [ ! -r /proc/device-tree/model ]; then
    echo 'No live device tree: board is unmeasured; run this script on the Radxa ZERO 3W.' >&2
    exit 1
fi
model=$(tr -d '\000' < /proc/device-tree/model)
case "$model" in *Radxa*ZERO*3*|*radxa*zero*3*|*Radxa*Zero*3*) ;; *)
    echo "Device model '$model' is not Radxa ZERO 3W; board is unmeasured." >&2
    exit 1 ;;
esac
if [ -e "$OUT" ]; then
    echo "output directory exists; refusing to overwrite: $OUT" >&2; exit 1
fi
mkdir -p "$OUT"
printf 'model=%s\nstarted_utc=%s\nrequested_duration_s=%s\nload=%s\ntrace=%s\n' "$model" "$(date -u +%FT%TZ)" "$DURATION" "$LOAD" "${BRIDGE_TRACE:-0}" > "$OUT/metadata.txt"
capture_hardware() {
    phase=$1
    {
        for governor in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do
            [ -r "$governor" ] || continue
            policy=${governor%/*}
            printf '%s governor=%s' "$policy" "$(cat "$governor")"
            [ ! -r "$policy/scaling_cur_freq" ] || printf ' current_khz=%s' "$(cat "$policy/scaling_cur_freq")"
            printf '\n'
        done
        for state in /sys/devices/system/cpu/cpu*/cpuidle/state*; do
            [ -r "$state/name" ] || continue
            printf '%s name=%s' "$state" "$(cat "$state/name")"
            for attr in latency usage time disable; do
                [ ! -r "$state/$attr" ] || printf ' %s=%s' "$attr" "$(cat "$state/$attr")"
            done
            printf '\n'
        done
        for zone in /sys/class/thermal/thermal_zone*/temp; do
            [ ! -r "$zone" ] || printf '%s millidegC=%s\n' "$zone" "$(cat "$zone")"
        done
        for speed in /sys/bus/usb/devices/*/speed; do
            [ ! -r "$speed" ] || printf '%s speed_Mbps=%s\n' "$speed" "$(cat "$speed")"
        done
        for udc in /sys/class/udc/*/state; do
            [ ! -r "$udc" ] || printf '%s state=%s\n' "$udc" "$(cat "$udc")"
        done
    } > "$OUT/hardware.$phase.txt"
}
capture_irq_threads() {
    phase=$1
    {
        for commfile in /proc/[0-9]*/task/[0-9]*/comm; do
            [ -r "$commfile" ] || continue
            IFS= read -r thread < "$commfile" || continue
            case "$thread" in irq/*)
                task=${commfile%/comm}
                printf '%s name=%s ' "$task" "$thread"
                if [ -r "$task/sched" ]; then
                    sed -n '/^policy /p; /^prio /p' "$task/sched" | tr '\n' ' '
                else
                    printf 'scheduler=unavailable'
                fi
                printf '\n' ;;
            esac
        done
    } > "$OUT/irq-threads.$phase.txt"
}
capture_hardware before
capture_irq_threads before
uname -a > "$OUT/uname.txt"
cat /proc/cmdline > "$OUT/cmdline.txt"
cat /proc/interrupts > "$OUT/interrupts.before.txt"
dmesg > "$OUT/dmesg.txt"
[ ! -r /proc/config.gz ] || cp /proc/config.gz "$OUT/kernel-config.gz"
[ ! -r /proc/pressure/cpu ] || cp /proc/pressure/cpu "$OUT/cpu-pressure.before.txt"
[ ! -r /proc/pressure/irq ] || cp /proc/pressure/irq "$OUT/irq-pressure.before.txt"
for irq in /proc/irq/[0-9]*/effective_affinity_list; do
    [ -r "$irq" ] || continue
    number=${irq#/proc/irq/}; number=${number%%/*}
    printf '%s %s\n' "$number" "$(cat "$irq")" >> "$OUT/irq-effective-affinities.txt"
done
if [ -r /run/bridge-daemon.pid ]; then
    pid=$(cat /run/bridge-daemon.pid)
    if kill -0 "$pid" 2>/dev/null; then
        cp "/proc/$pid/sched" "$OUT/daemon-sched.before.txt"
        cp "/proc/$pid/status" "$OUT/daemon-status.before.txt"
        rm -f /run/bridge-daemon.stats
        kill -USR1 "$pid"
        sleep 1
        [ ! -r /run/bridge-daemon.stats ] || cp /run/bridge-daemon.stats "$OUT/daemon-stats.before.txt"
    fi
fi
# Histogram is scheduler wake latency, NOT host-to-gadget or HID wire latency.
if [ "$LOAD" = stress ]; then
    if ! command -v stress-ng >/dev/null 2>&1; then
        echo 'stress-ng requested but unavailable; no stress capture was run' >&2
        exit 1
    fi
    stress-ng --cpu 2 --io 1 --vm 1 --vm-bytes 32M --timeout "${DURATION}s" --metrics-brief > "$OUT/stress-ng.txt" 2>&1 &
    stress_pid=$!
fi
if [ "${BRIDGE_TRACE:-0}" = 1 ]; then
    if command -v trace-cmd >/dev/null 2>&1; then
        trace-cmd record -o "$OUT/trace.dat" -e irq -e sched -e usb sleep "$DURATION" > "$OUT/trace-cmd.txt" 2>&1 &
        trace_pid=$!
    else
        echo 'trace-cmd requested but unavailable; no kernel trace recorded' > "$OUT/trace-cmd.unavailable"
    fi
fi
if command -v cyclictest >/dev/null 2>&1; then
    cyclictest -p 80 -i 1000 -m -q -D "$DURATION" -h 1000 > "$OUT/cyclictest.txt" 2> "$OUT/cyclictest.stderr" ||
        echo 'cyclictest failed; inspect cyclictest.stderr' > "$OUT/cyclictest.error"
else
    echo 'cyclictest unavailable (add rt-tests package)' > "$OUT/cyclictest.unavailable"
    sleep "$DURATION"
fi
if [ -n "${stress_pid:-}" ]; then
    wait "$stress_pid" || echo 'stress-ng failed; inspect stress-ng.txt' > "$OUT/stress-ng.error"
fi
if [ -n "${trace_pid:-}" ]; then
    wait "$trace_pid" || echo 'trace-cmd failed; inspect trace-cmd.txt' > "$OUT/trace-cmd.error"
fi
cat /proc/interrupts > "$OUT/interrupts.after.txt"
capture_hardware after
capture_irq_threads after
[ ! -r /proc/pressure/cpu ] || cp /proc/pressure/cpu "$OUT/cpu-pressure.after.txt"
if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    cp "/proc/$pid/sched" "$OUT/daemon-sched.after.txt"
    cp "/proc/$pid/status" "$OUT/daemon-status.after.txt"
    rm -f /run/bridge-daemon.stats
    kill -USR1 "$pid"
    sleep 1
    [ ! -r /run/bridge-daemon.stats ] || cp /run/bridge-daemon.stats "$OUT/daemon-stats.after.txt"
fi
printf 'finished_utc=%s\n' "$(date -u +%FT%TZ)" >> "$OUT/metadata.txt"
echo "Captured observed diagnostics to $OUT; no end-to-end wire samples were taken."
