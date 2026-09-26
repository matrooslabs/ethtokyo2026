#include "keccak256.h"

#include <string.h>

static uint64_t rol(uint64_t value, unsigned shift)
{
    return shift ? value << shift | value >> (64u - shift) : value;
}

static uint64_t load64(const uint8_t *p)
{
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i)
        value |= (uint64_t)p[i] << (8u * i);
    return value;
}

static void store64(uint8_t *p, uint64_t value)
{
    for (unsigned i = 0; i < 8; ++i)
        p[i] = (uint8_t)(value >> (8u * i));
}

static void keccak_f(uint64_t state[25])
{
    static const uint64_t rc[24] = {
        0x0000000000000001ULL, 0x0000000000008082ULL,
        0x800000000000808aULL, 0x8000000080008000ULL,
        0x000000000000808bULL, 0x0000000080000001ULL,
        0x8000000080008081ULL, 0x8000000000008009ULL,
        0x000000000000008aULL, 0x0000000000000088ULL,
        0x0000000080008009ULL, 0x000000008000000aULL,
        0x000000008000808bULL, 0x800000000000008bULL,
        0x8000000000008089ULL, 0x8000000000008003ULL,
        0x8000000000008002ULL, 0x8000000000000080ULL,
        0x000000000000800aULL, 0x800000008000000aULL,
        0x8000000080008081ULL, 0x8000000000008080ULL,
        0x0000000080000001ULL, 0x8000000080008008ULL,
    };
    static const unsigned rotation[25] = {
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20,
        3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
        18, 2, 61, 56, 14,
    };
    for (unsigned round = 0; round < 24; ++round) {
        uint64_t c[5], d[5], b[25];
        for (unsigned x = 0; x < 5; ++x)
            c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        for (unsigned x = 0; x < 5; ++x)
            d[x] = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1);
        for (unsigned y = 0; y < 5; ++y)
            for (unsigned x = 0; x < 5; ++x)
                state[x + 5 * y] ^= d[x];
        for (unsigned y = 0; y < 5; ++y)
            for (unsigned x = 0; x < 5; ++x)
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rol(state[x + 5 * y], rotation[x + 5 * y]);
        for (unsigned y = 0; y < 5; ++y)
            for (unsigned x = 0; x < 5; ++x)
                state[x + 5 * y] = b[x + 5 * y] ^
                    (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]);
        state[0] ^= rc[round];
    }
}

void osum_keccak256(const uint8_t *input, size_t length, uint8_t output[32])
{
    enum { RATE = 136 };
    uint64_t state[25] = {0};
    while (length >= RATE) {
        for (unsigned i = 0; i < RATE / 8; ++i)
            state[i] ^= load64(input + i * 8);
        keccak_f(state);
        input += RATE;
        length -= RATE;
    }
    uint8_t block[RATE] = {0};
    memcpy(block, input, length);
    block[length] = 0x01; /* Keccak domain, not SHA3 domain. */
    block[RATE - 1] |= 0x80;
    for (unsigned i = 0; i < RATE / 8; ++i)
        state[i] ^= load64(block + i * 8);
    keccak_f(state);
    for (unsigned i = 0; i < 4; ++i)
        store64(output + i * 8, state[i]);
}
