#ifndef KECCAK256_H
#define KECCAK256_H

#include <stddef.h>
#include <stdint.h>

void osum_keccak256(const uint8_t *input, size_t length, uint8_t output[32]);

#endif
