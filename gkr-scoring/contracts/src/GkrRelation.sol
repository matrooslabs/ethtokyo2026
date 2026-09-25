// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GkrMath} from "./GkrMath.sol";

/// @notice The scoring relation evaluated at the row-sumcheck point (SPEC.md §6, §7.2 step 4).
/// @dev Identical to engine/src/scoring/relation.rs `table_poly`, summed over all tables with
///      zero-padding factors. Split from the verifier only to respect EIP-170.
contract GkrRelation {
    uint256 internal constant R = GkrMath.R;
    uint256 internal constant W = 136500;
    uint256 internal constant S16 = 65536;

    struct Input {
        uint256[7] bits;
        uint256[] r; // zerocheck point (R_max)
        uint256[] rp; // sumcheck output point r' (R_max)
        uint256[] z; // GKR leaf point
        uint256[] chi; // slot selectors, tables in order, slots in order (74)
        uint256[] claims; // 138 column claims at r'_{<R_T}
        uint256[9] al; // α^0..α^8
        uint256 gamma;
        uint256 lambda;
        uint256 beta;
        uint256[5] kz; // κ ζ^c
        uint256 m;
        uint256 n;
        uint256 duration;
    }

    struct T {
        uint256[9] al;
        uint256 gamma;
        uint256 lambda;
        uint256[] chi;
        uint256 chiOff;
    }

    function rowPoly(Input calldata inp) external pure returns (uint256 total) {
        unchecked {
            uint256[] memory rp = inp.rp;
            uint256[] memory z = inp.z;
            uint256[] memory claims = inp.claims;
            T memory ctx = T({al: inp.al, gamma: inp.gamma, lambda: inp.lambda, chi: inp.chi, chiOff: 0});
            uint256[4] memory st = [GkrMath.eqArr(inp.r, rp, 0, rp.length), 1, 0, inp.beta]; // eqr, betaPow, cursor, beta
            uint256[3] memory pub = [inp.m, inp.n, inp.duration];
            for (uint256 t = 0; t < 7; t++) {
                total = addmod(total, _table(ctx, t, inp.bits[t], rp, z, claims, st, pub, inp.kz), R);
            }
        }
    }

    function _table(
        T memory ctx,
        uint256 t,
        uint256 bits,
        uint256[] memory rp,
        uint256[] memory z,
        uint256[] memory claims,
        uint256[4] memory st,
        uint256[3] memory pub,
        uint256[5] calldata kz
    ) internal pure returns (uint256 total) {
        unchecked {
            uint256 pad = GkrMath.pad(rp, bits);
            uint256 eqz = mulmod(GkrMath.eqArr(z, rp, 0, bits), pad, R);
            uint256 nAdvSrc = t < 4 ? 23 : (t == 4 ? 37 : (t == 5 ? 8 : 1));
            uint256[] memory v = new uint256[](nAdvSrc + (t < 4 ? 3 : (t == 4 ? 1 : (t == 5 ? 4 : 1))));
            for (uint256 i = 0; i < nAdvSrc; i++) {
                v[i] = mulmod(claims[st[2] + i], pad, R);
            }
            st[2] += nAdvSrc;
            _publics(rp, bits, t, v, nAdvSrc, pad, pub[0], pub[1]);
            uint256 cons;
            uint256 slotsAcc;
            uint256 bp = st[1];
            if (t < 4) {
                (cons, bp) = _laneCons(v, bp, st[3]);
                slotsAcc = _laneSlots(ctx, v, t);
            } else if (t == 4) {
                (cons, bp) = _chartCons(v, bp, st[3]);
                slotsAcc = _chartSlots(ctx, v);
                for (uint256 k = 0; k < 5; k++) {
                    total = addmod(total, mulmod(kz[k], addmod(v[6 + k], v[12 + k], R), R), R);
                }
            } else if (t == 5) {
                (cons, bp) = _traceCons(v, bp, st[3], pub[2]);
                slotsAcc = _traceSlots(ctx, v);
            } else {
                // byte table: p = −μ, q = γ − (9 + α·val)
                uint256 q = addmod(ctx.gamma, R - addmod(9, mulmod(ctx.al[1], v[1], R), R), R);
                slotsAcc = _slot(ctx, 0, _neg(v[0]), q);
            }
            st[1] = bp;
            ctx.chiOff += t < 4 ? 12 : (t == 4 ? 18 : (t == 5 ? 7 : 1));
            total = addmod(total, addmod(mulmod(st[0], cons, R), mulmod(eqz, slotsAcc, R), R), R);
        }
    }

    function _publics(
        uint256[] memory y,
        uint256 bits,
        uint256 t,
        uint256[] memory v,
        uint256 at,
        uint256 pad,
        uint256 m,
        uint256 n
    ) internal pure {
        unchecked {
            if (t < 4) {
                uint256 first = 1;
                uint256 last = 1;
                for (uint256 j = 0; j < bits; j++) {
                    first = mulmod(first, addmod(1, R - y[j], R), R);
                    last = mulmod(last, y[j], R);
                }
                v[at] = mulmod(first, pad, R);
                v[at + 1] = mulmod(last, pad, R);
                v[at + 2] = mulmod(GkrMath.idMle(y, bits), pad, R);
            } else if (t == 4) {
                v[at] = mulmod(GkrMath.stepMle(m, y, bits), pad, R);
            } else if (t == 5) {
                v[at] = mulmod(GkrMath.stepMle(n, y, bits), pad, R);
                v[at + 1] = mulmod(GkrMath.eqConst(n, y, 0, bits), pad, R);
                uint256 first = 1;
                for (uint256 j = 0; j < bits; j++) {
                    first = mulmod(first, addmod(1, R - y[j], R), R);
                }
                v[at + 2] = mulmod(first, pad, R);
                v[at + 3] = mulmod(GkrMath.idMle(y, bits), pad, R);
            } else {
                v[at] = mulmod(GkrMath.idMle(y, bits), pad, R);
            }
        }
    }

    function _acc(uint256 acc, uint256 betaPow, uint256 beta, uint256 term) internal pure returns (uint256, uint256) {
        unchecked {
            return (addmod(acc, mulmod(betaPow, term, R), R), mulmod(betaPow, beta, R));
        }
    }

    function _limbs(uint256[] memory v, uint256 start, uint256 count) internal pure returns (uint256 acc) {
        unchecked {
            for (uint256 i = count; i > 0; i--) {
                acc = addmod(mulmod(acc, 256, R), v[start + i - 1], R);
            }
        }
    }

    function _bool(uint256 x) internal pure returns (uint256) {
        unchecked {
            return mulmod(x, addmod(x, R - 1, R), R);
        }
    }

    function _neg(uint256 x) internal pure returns (uint256) {
        unchecked {
            return x == 0 ? 0 : R - x;
        }
    }

    // lane columns: 0 isO,1 isC,2 isD,3 isU,4 v,5 q,6 kl,7 O,8 F,9 H,10 A,11 Kx,12 lastK,13 inv,
    //               14 mD,15 cC,16-22 limbs, 23 isFirst,24 isLast,25 id
    function _laneKey(uint256[] memory v) internal pure returns (uint256) {
        unchecked {
            uint256 fourV = mulmod(v[4], 4, R);
            uint256 ev = addmod(v[2], v[3], R);
            uint256 inner = addmod(
                addmod(mulmod(fourV, v[0], R), mulmod(addmod(fourV, 8 * W + 2, R), v[1], R), R),
                mulmod(addmod(fourV, 4 * W + 1, R), ev, R),
                R
            );
            return addmod(mulmod(S16, inner, R), mulmod(v[5], ev, R), R);
        }
    }

    function _laneCons(uint256[] memory v, uint256 bp, uint256 beta) internal pure returns (uint256 acc, uint256) {
        unchecked {
            uint256 isReal = addmod(addmod(v[0], v[1], R), addmod(v[2], v[3], R), R);
            uint256 om = addmod(v[7], R - v[8], R); // O − F
            uint256 fk = addmod(v[8], R - v[6], R); // F − kl
            for (uint256 i = 0; i < 4; i++) {
                (acc, bp) = _acc(acc, bp, beta, _bool(v[i]));
            }
            (acc, bp) = _acc(acc, bp, beta, _bool(isReal));
            (acc, bp) = _acc(
                acc, bp, beta, mulmod(isReal, addmod(addmod(_laneKey(v), R - v[12], R), R - _limbs(v, 16, 7), R), R)
            );
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[0], addmod(v[6], R - v[7], R), R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[2], v[9], R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[3], addmod(1, R - v[9], R), R));
            (acc, bp) = _acc(acc, bp, beta, _bool(v[14]));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[14], addmod(1, R - v[2], R), R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(mulmod(v[2], addmod(1, R - v[14], R), R), om, R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[14], addmod(mulmod(om, v[13], R), R - 1, R), R));
            (acc, bp) = _acc(acc, bp, beta, _bool(v[15]));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[15], addmod(1, R - v[1], R), R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[15], fk, R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(addmod(v[1], R - v[15], R), addmod(mulmod(fk, v[13], R), R - 1, R), R));
            for (uint256 i = 7; i <= 12; i++) {
                (acc, bp) = _acc(acc, bp, beta, mulmod(v[23], v[i], R));
            }
            return (acc, bp);
        }
    }

    /// γ − (tag + Σ α^i a_i)
    function _den(T memory c, uint256 tag, uint256[] memory a) internal pure returns (uint256) {
        unchecked {
            uint256 acc = tag;
            for (uint256 i = 0; i < a.length; i++) {
                acc = addmod(acc, mulmod(c.al[i + 1], a[i], R), R);
            }
            return addmod(c.gamma, R - acc, R);
        }
    }

    function _slot(T memory c, uint256 s, uint256 p, uint256 q) internal pure returns (uint256) {
        unchecked {
            return mulmod(c.chi[c.chiOff + s], addmod(p, mulmod(c.lambda, q, R), R), R);
        }
    }

    function _limbSlot(T memory c, uint256 s, uint256 limb) internal pure returns (uint256) {
        unchecked {
            return _slot(c, s, 1, addmod(c.gamma, R - addmod(9, mulmod(c.al[1], limb, R), R), R));
        }
    }

    function _laneSlots(T memory c, uint256[] memory v, uint256 lane) internal pure returns (uint256 acc) {
        unchecked {
            uint256 isReal = addmod(addmod(v[0], v[1], R), addmod(v[2], v[3], R), R);
            uint256[] memory a = new uint256[](4);
            {
                uint256 tag =
                    addmod(addmod(v[0], mulmod(2, v[1], R), R), addmod(mulmod(3, v[2], R), mulmod(4, v[3], R), R), R);
                (a[0], a[1], a[2], a[3]) = (lane, v[4], v[5], v[6]);
                acc = _slot(c, 0, isReal, _den(c, tag, a));
                (a[2], a[3]) = (0, v[8]);
                acc = addmod(acc, _slot(c, 1, v[14], _den(c, 5, a)), R);
                a[3] = v[11];
                acc = addmod(acc, _slot(c, 2, mulmod(v[3], v[10], R), _den(c, 6, a)), R);
            }
            uint256[] memory st8 = new uint256[](8);
            (st8[0], st8[1], st8[2], st8[3], st8[4], st8[5], st8[6], st8[7]) =
                (lane, v[25], v[7], v[8], v[9], v[10], v[11], v[12]);
            acc = addmod(acc, _slot(c, 3, addmod(v[23], R - 1, R), _den(c, 7, st8)), R);
            {
                uint256 notEvent = addmod(1, R - addmod(v[2], v[3], R), R);
                st8[1] = addmod(v[25], 1, R);
                st8[2] = addmod(v[7], v[0], R);
                st8[3] = addmod(addmod(v[8], v[14], R), v[15], R);
                st8[4] = addmod(addmod(v[9], v[2], R), R - v[3], R);
                st8[5] = addmod(mulmod(notEvent, v[10], R), v[14], R);
                st8[6] = addmod(mulmod(notEvent, v[11], R), mulmod(v[14], v[8], R), R);
                st8[7] = addmod(v[12], mulmod(isReal, addmod(_laneKey(v), R - v[12], R), R), R);
                acc = addmod(acc, _slot(c, 4, addmod(1, R - v[24], R), _den(c, 7, st8)), R);
            }
            for (uint256 i = 0; i < 7; i++) {
                acc = addmod(acc, _limbSlot(c, 5 + i, v[16 + i]), R);
            }
        }
    }

    // chart columns: 0 hit,1 th,2 rel,3 u,4 hh,5 σ,6-10 h,11 τ,12-17 g,18-31 limbs,
    //                32 lane,33 s,34 e,35 hold,36 kl,37 realN
    function _chartCons(uint256[] memory v, uint256 bp, uint256 beta) internal pure returns (uint256 acc, uint256) {
        unchecked {
            (acc, bp) = _acc(acc, bp, beta, _bool(v[0]));
            (acc, bp) = _acc(acc, bp, beta, _bool(v[2]));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[2], addmod(1, R - v[0], R), R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[0], addmod(1, R - v[37], R), R));
            (acc, bp) = _acc(acc, bp, beta, addmod(v[4], R - mulmod(v[0], v[35], R), R));
            (acc, bp) = _acc(acc, bp, beta, _bool(v[5]));
            uint256 sumH;
            uint256 lo;
            uint256 hi;
            uint32[5] memory LO = [uint32(0), 19_501, 49_501, 82_501, 112_501];
            uint32[5] memory HI = [uint32(19_500), 49_500, 82_500, 112_500, 136_500];
            for (uint256 k = 0; k < 5; k++) {
                uint256 h = v[6 + k];
                (acc, bp) = _acc(acc, bp, beta, _bool(h));
                sumH = addmod(sumH, h, R);
                lo = addmod(lo, mulmod(h, LO[k], R), R);
                hi = addmod(hi, mulmod(h, HI[k], R), R);
            }
            (acc, bp) = _acc(acc, bp, beta, addmod(sumH, R - v[0], R));
            uint256 delta = mulmod(addmod(mulmod(2, v[5], R), R - 1, R), addmod(v[1], R - v[33], R), R);
            (acc, bp) = _acc(acc, bp, beta, addmod(addmod(delta, R - lo, R), R - _limbs(v, 18, 3), R));
            (acc, bp) = _acc(acc, bp, beta, addmod(addmod(hi, R - delta, R), R - _limbs(v, 21, 3), R));
            (acc, bp) = _acc(acc, bp, beta, _bool(v[11]));
            uint256 sumG;
            lo = 0;
            hi = 0;
            uint64[6] memory LO2 = [uint64(0), 19_501, 49_501, 82_501, 112_501, 136_501];
            uint64[6] memory HI2 = [uint64(19_500), 49_500, 82_500, 112_500, 136_500, 4294967295];
            for (uint256 k = 0; k < 6; k++) {
                uint256 gk = v[12 + k];
                (acc, bp) = _acc(acc, bp, beta, _bool(gk));
                sumG = addmod(sumG, gk, R);
                lo = addmod(lo, mulmod(gk, LO2[k], R), R);
                hi = addmod(hi, mulmod(gk, HI2[k], R), R);
            }
            (acc, bp) = _acc(acc, bp, beta, addmod(sumG, R - v[4], R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(mulmod(v[4], addmod(1, R - v[2], R), R), addmod(1, R - v[17], R), R));
            uint256 delta2 =
                mulmod(v[35], mulmod(addmod(mulmod(2, v[11], R), R - 1, R), addmod(v[3], R - v[34], R), R), R);
            (acc, bp) = _acc(acc, bp, beta, addmod(addmod(delta2, R - lo, R), R - _limbs(v, 24, 4), R));
            (acc, bp) = _acc(acc, bp, beta, addmod(addmod(hi, R - delta2, R), R - _limbs(v, 28, 4), R));
            return (acc, bp);
        }
    }

    function _chartSlots(T memory c, uint256[] memory v) internal pure returns (uint256 acc) {
        unchecked {
            uint256[] memory a = new uint256[](4);
            (a[0], a[1], a[2], a[3]) = (v[32], v[33], 0, v[36]);
            uint256 negReal = _neg(v[37]);
            acc = _slot(c, 0, negReal, _den(c, 1, a));
            acc = addmod(acc, _slot(c, 1, negReal, _den(c, 2, a)), R);
            a[1] = v[1];
            acc = addmod(acc, _slot(c, 2, _neg(v[0]), _den(c, 5, a)), R);
            a[1] = v[3];
            acc = addmod(acc, _slot(c, 3, _neg(mulmod(v[0], v[2], R)), _den(c, 6, a)), R);
            for (uint256 i = 0; i < 14; i++) {
                acc = addmod(acc, _limbSlot(c, 4 + i, v[18 + i]), R);
            }
        }
    }

    // trace columns: 0 P, 1-4 d, 5 t, 6 lane, 7 act, 8 real, 9 isEnd, 10 isFirst, 11 idx
    function _traceCons(uint256[] memory v, uint256 bp, uint256 beta, uint256 duration)
        internal
        pure
        returns (uint256 acc, uint256)
    {
        unchecked {
            uint256 x =
                addmod(mulmod(v[8], addmod(v[5], R - v[0], R), R), mulmod(v[9], addmod(duration, R - v[0], R), R), R);
            (acc, bp) = _acc(acc, bp, beta, addmod(x, R - _limbs(v, 1, 4), R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[10], v[0], R));
            (acc, bp) = _acc(acc, bp, beta, mulmod(v[8], _bool(v[7]), R));
            return (acc, bp);
        }
    }

    function _traceSlots(T memory c, uint256[] memory v) internal pure returns (uint256 acc) {
        unchecked {
            uint256[] memory a = new uint256[](4);
            (a[0], a[1], a[2], a[3]) = (v[6], v[5], v[11], 0);
            acc = _slot(c, 0, _neg(v[8]), _den(c, addmod(3, v[7], R), a));
            uint256[] memory b = new uint256[](2);
            (b[0], b[1]) = (addmod(v[11], 1, R), v[5]);
            acc = addmod(acc, _slot(c, 1, v[8], _den(c, 8, b)), R);
            (b[0], b[1]) = (v[11], v[0]);
            uint256 p = mulmod(addmod(v[8], v[9], R), addmod(1, R - v[10], R), R);
            acc = addmod(acc, _slot(c, 2, _neg(p), _den(c, 8, b)), R);
            for (uint256 i = 0; i < 4; i++) {
                acc = addmod(acc, _limbSlot(c, 3 + i, v[1 + i]), R);
            }
        }
    }
}
