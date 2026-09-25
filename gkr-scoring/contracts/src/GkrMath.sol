// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice BN254 scalar-field helpers shared by the verifier contracts (SPEC.md §3).
library GkrMath {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant INV2 = 10944121435919637611123202872628637544274182200208017171849102093287904247809;
    uint256 internal constant INV4 = 16416182153879456416684804308942956316411273300312025757773653139931856371713;
    uint256 internal constant INV6 = 18240202393199396018538671454381062573790303667013361953081836822146507079681;
    uint256 internal constant INV24 = 20976232752179305421319472172538221959858849217065366246044112345468483141633;

    function log2ceil(uint256 x) internal pure returns (uint256 k) {
        while ((uint256(1) << k) < x) k++;
    }

    function eq1(uint256 a, uint256 b) internal pure returns (uint256) {
        // ab + (1-a)(1-b) = 2ab − a − b + 1
        return addmod(addmod(mulmod(2, mulmod(a, b, R), R), R - a, R), addmod(R - b, 1, R), R);
    }

    /// eq(x[0..len], y[yOff..yOff+len])
    function eqArr(uint256[] memory x, uint256[] memory y, uint256 yOff, uint256 len) internal pure returns (uint256 acc) {
        require(len <= x.length && yOff + len <= y.length, "eqArr bounds");
        assembly ("memory-safe") {
            acc := 1
            let px := add(x, 32)
            let py := add(add(y, 32), mul(yOff, 32))
            for { let j := 0 } lt(j, len) { j := add(j, 1) } {
                let a := mload(add(px, mul(j, 32)))
                let b := mload(add(py, mul(j, 32)))
                // 2ab − a − b + 1
                let t := addmod(addmod(mulmod(2, mulmod(a, b, R), R), sub(R, a), R), addmod(sub(R, b), 1, R), R)
                acc := mulmod(acc, t, R)
            }
        }
    }

    /// eq(bits(v), x[from..to])
    function eqConst(uint256 v, uint256[] memory x, uint256 from, uint256 to) internal pure returns (uint256 acc) {
        require(from <= to && to <= x.length, "eqConst bounds");
        assembly ("memory-safe") {
            acc := 1
            let p := add(x, 32)
            for { let j := from } lt(j, to) { j := add(j, 1) } {
                let xj := mload(add(p, mul(j, 32)))
                switch and(shr(sub(j, from), v), 1)
                case 1 { acc := mulmod(acc, xj, R) }
                default { acc := mulmod(acc, addmod(1, sub(R, xj), R), R) }
            }
        }
    }

    /// Π_{j ≥ from} (1 − x_j)
    function pad(uint256[] memory x, uint256 from) internal pure returns (uint256 acc) {
        assembly ("memory-safe") {
            acc := 1
            let len := mload(x)
            let p := add(x, 32)
            for { let j := from } lt(j, len) { j := add(j, 1) } {
                acc := mulmod(acc, addmod(1, sub(R, mload(add(p, mul(j, 32)))), R), R)
            }
        }
    }

    function idMle(uint256[] memory x, uint256 len) internal pure returns (uint256 acc) {
        require(len <= x.length, "idMle bounds");
        assembly ("memory-safe") {
            let pw := 1
            let p := add(x, 32)
            for { let j := 0 } lt(j, len) { j := add(j, 1) } {
                acc := addmod(acc, mulmod(pw, mload(add(p, mul(j, 32))), R), R)
                pw := addmod(pw, pw, R)
            }
        }
    }

    /// MLE of i ↦ [i < n] over x[0..len]
    function stepMle(uint256 n, uint256[] memory x, uint256 len) internal pure returns (uint256 acc) {
        if (len < 64 && n >= (uint256(1) << len)) return 1;
        uint256 prefix = 1;
        for (uint256 jj = len; jj > 0; jj--) {
            uint256 j = jj - 1;
            if ((n >> j) & 1 == 1) {
                acc = addmod(acc, mulmod(prefix, addmod(1, R - x[j], R), R), R);
                prefix = mulmod(prefix, x[j], R);
            } else {
                prefix = mulmod(prefix, addmod(1, R - x[j], R), R);
            }
        }
    }

    function interp3(uint256 e0, uint256 e1, uint256 e2, uint256 x) internal pure returns (uint256) {
        uint256 x1 = addmod(x, R - 1, R);
        uint256 x2 = addmod(x, R - 2, R);
        uint256 acc = mulmod(e0, mulmod(mulmod(x1, x2, R), INV2, R), R);
        acc = addmod(acc, mulmod(e1, R - mulmod(x, x2, R), R), R);
        return addmod(acc, mulmod(e2, mulmod(mulmod(x, x1, R), INV2, R), R), R);
    }

    function interp4(uint256 e0, uint256 e1, uint256 e2, uint256 e3, uint256 x) internal pure returns (uint256) {
        uint256 x1 = addmod(x, R - 1, R);
        uint256 x2 = addmod(x, R - 2, R);
        uint256 x3 = addmod(x, R - 3, R);
        uint256 acc = mulmod(e0, R - mulmod(mulmod(mulmod(x1, x2, R), x3, R), INV6, R), R);
        acc = addmod(acc, mulmod(e1, mulmod(mulmod(mulmod(x, x2, R), x3, R), INV2, R), R), R);
        acc = addmod(acc, mulmod(e2, R - mulmod(mulmod(mulmod(x, x1, R), x3, R), INV2, R), R), R);
        return addmod(acc, mulmod(e3, mulmod(mulmod(mulmod(x, x1, R), x2, R), INV6, R), R), R);
    }

    function interp5(uint256[5] memory e, uint256 x) internal pure returns (uint256 acc) {
        uint256[5] memory d;
        for (uint256 i = 0; i < 5; i++) {
            d[i] = addmod(x, R - i, R);
        }
        uint256 p01 = mulmod(d[0], d[1], R);
        uint256 p34 = mulmod(d[3], d[4], R);
        // L_i = Π_{j≠i} d_j / den_i, den = [24, −6, 4, −6, 24]
        acc = mulmod(e[0], mulmod(mulmod(mulmod(d[1], d[2], R), p34, R), INV24, R), R);
        acc = addmod(acc, mulmod(e[1], R - mulmod(mulmod(mulmod(d[0], d[2], R), p34, R), INV6, R), R), R);
        acc = addmod(acc, mulmod(e[2], mulmod(mulmod(p01, p34, R), INV4, R), R), R);
        acc = addmod(acc, mulmod(e[3], R - mulmod(mulmod(mulmod(p01, d[2], R), d[4], R), INV6, R), R), R);
        acc = addmod(acc, mulmod(e[4], mulmod(mulmod(mulmod(p01, d[2], R), d[3], R), INV24, R), R), R);
    }

}
