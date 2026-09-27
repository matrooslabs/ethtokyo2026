.PHONY: all debug verify test-ta
all:
	./scripts/build.sh production
debug:
	./scripts/build.sh debug
verify:
	./scripts/verify.sh output production
test-ta:
	@binary=$$(mktemp /tmp/versu-mode-b-ta.XXXXXX); \
	trap 'rm -f "$$binary"' EXIT; \
	cc -std=gnu11 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
	  -Itests/ta-host -Ioptee/osumania_signer/include -Ioptee/osumania_signer/ta \
	  tests/ta-host/test_mode_b_ta.c optee/osumania_signer/ta/keccak256.c \
	  optee/osumania_signer/ta/third_party/micro-ecc/uECC.c -lcrypto -o "$$binary" && "$$binary"
