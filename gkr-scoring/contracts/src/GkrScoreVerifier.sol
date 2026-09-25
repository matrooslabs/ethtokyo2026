// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GkrMath} from "./GkrMath.sol";
import {GkrRelation} from "./GkrRelation.sol";

/// @notice Stateless verifier for OSUMANIA_GKR_V1 scoring proofs (SPEC.md §7).
/// @dev Mirrors engine/src/scoring/verifier.rs step by step. Every prover word is a
///      canonical field element (< R) or a G1 coordinate checked by the precompiles.
contract GkrScoreVerifier {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant W = 136500;
    uint256 internal constant MAX_EVENTS = 50_000;
    uint256 internal constant MAX_NOTES = 10_000;
    uint256 internal constant MAX_DURATION = 1_800_000_000;
    uint256 internal constant N_CLAIMS = 138;

    struct Statement {
        uint8 mode; // 1 = calldata trace (A), 2 = device-committed trace (B)
        bytes32 sessionDigest;
        uint64 n;
        uint64 duration;
        uint256[2] chartCommitment;
        uint64 m;
        uint8 chartBits;
        uint64 components;
        uint64 maxEnd;
        uint256[2] traceCommitment; // mode B only
        uint8[4] laneBits;
        uint32[5] counts;
    }

    struct Ctx {
        bytes32 s;
        uint256 pos;
        uint256[7] bits;
        uint256 rmax;
        uint256 g;
        uint256 a;
        uint256[9] al;
        uint256 gamma;
        uint256 lambda;
        uint256[5] kz;
        uint256[] z;
        uint256[] r;
        uint256[] rp;
        uint256[] zs;
        uint256[][7] chi;
        uint256[7] leafBase; // offset >> bits
        uint256[7] advSel; // block offset >> (bits + colLog)
        uint256 p;
        uint256 q;
    }

    GkrRelation public immutable relation;
    uint256 public immutable smax;
    bytes32 public immutable srsId;
    uint256 internal immutable g2OneXi;
    uint256 internal immutable g2OneXr;
    uint256 internal immutable g2OneYi;
    uint256 internal immutable g2OneYr;
    uint256 internal immutable g2TauXi;
    uint256 internal immutable g2TauXr;
    uint256 internal immutable g2TauYi;
    uint256 internal immutable g2TauYr;
    /// shift[n] = [τ^{2^smax − 2^n}]_2 in EIP-197 word order.
    uint256[4][] internal g2Shift;

    constructor(GkrRelation relation_, uint256 smax_, uint256[4] memory one, uint256[4] memory tau, uint256[4][] memory shift) {
        require(shift.length == smax_ + 1 && smax_ >= 3 && smax_ <= 28, "bad SRS key");
        relation = relation_;
        smax = smax_;
        (g2OneXi, g2OneXr, g2OneYi, g2OneYr) = (one[0], one[1], one[2], one[3]);
        (g2TauXi, g2TauXr, g2TauYi, g2TauYr) = (tau[0], tau[1], tau[2], tau[3]);
        bytes memory packed = abi.encodePacked(tau);
        for (uint256 i = 0; i < shift.length; i++) {
            g2Shift.push(shift[i]);
            if (i >= 1) packed = bytes.concat(packed, abi.encodePacked(shift[i]));
        }
        srsId = keccak256(packed);
    }

    // ------------------------------------------------------------------ entry

    /// @return judgements PERFECT, GREAT, GOOD, OK, MEH, MISS
    /// @return score floor(1e6 · achieved / (320 · components))
    function verify(Statement calldata st, uint256[] calldata proof, bytes calldata events)
        external
        view
        returns (uint256[6] memory judgements, uint256 score)
    {
        (judgements, score) = _checkStatement(st);
        Ctx memory c;
        _shape(c, st);
        require(c.a <= smax, "instance exceeds SRS");
        c.s = keccak256("OSUMANIA_GKR_V1");
        _absorbStatement(c, st, proof);
        c.al[0] = 1;
        c.al[1] = _squeeze(c);
        for (uint256 i = 2; i < 9; i++) {
            c.al[i] = mulmod(c.al[i - 1], c.al[1], R);
        }
        c.gamma = _squeeze(c);
        _gkr(c, proof);
        _rowSumcheck(c, proof, st);
        _reductionAndOpening(c, proof, st, events);
        require(c.pos == proof.length, "trailing proof words");
    }

    function _checkStatement(Statement calldata st) internal pure returns (uint256[6] memory j, uint256 score) {
        require(st.mode == 1 || st.mode == 2, "bad mode");
        require(st.n <= MAX_EVENTS, "too many events");
        require(st.m >= 1 && st.m <= MAX_NOTES && st.chartBits == GkrMath.log2ceil(st.m), "bad chart");
        require(st.duration <= MAX_DURATION && st.duration >= uint256(st.maxEnd) + W, "bad duration");
        uint256 hits;
        for (uint256 i = 0; i < 5; i++) {
            j[i] = st.counts[i];
            hits += j[i];
        }
        require(st.components > 0 && hits <= st.components, "bad counts");
        j[5] = st.components - hits;
        uint256 achieved = 320 * j[0] + 300 * j[1] + 200 * j[2] + 100 * j[3] + 50 * j[4];
        score = (1_000_000 * achieved) / (320 * uint256(st.components));
        for (uint256 i = 0; i < 4; i++) {
            require(st.laneBits[i] <= 17, "lane table too large");
        }
    }

    // ------------------------------------------------------------------ shape

    function _colLog(uint256 t) internal pure returns (uint256) {
        return t < 5 ? 5 : (t == 5 ? 3 : 0);
    }

    function _slots(uint256 t) internal pure returns (uint256) {
        return t < 4 ? 12 : (t == 4 ? 18 : (t == 5 ? 7 : 1));
    }

    function _shape(Ctx memory c, Statement calldata st) internal pure {
        for (uint256 i = 0; i < 4; i++) {
            c.bits[i] = st.laneBits[i];
        }
        c.bits[4] = st.chartBits;
        c.bits[5] = GkrMath.log2ceil(uint256(st.n) + 1);
        c.bits[6] = 8;
        uint256 rmax;
        for (uint256 i = 0; i < 7; i++) {
            if (c.bits[i] > rmax) rmax = c.bits[i];
        }
        c.rmax = rmax;
        // Leaf layout: tables ordered by (bits desc, index asc), slots contiguous.
        uint256 off;
        for (uint256 b = rmax + 1; b > 0; b--) {
            for (uint256 t = 0; t < 7; t++) {
                if (c.bits[t] == b - 1) {
                    c.leafBase[t] = off >> c.bits[t];
                    off += _slots(t) << c.bits[t];
                }
            }
        }
        c.g = GkrMath.log2ceil(off);
        if (c.g == 0) c.g = 1;
        // ADV layout: blocks ordered by (bits + colLog desc, index asc).
        off = 0;
        for (uint256 b = rmax + 6; b > 0; b--) {
            for (uint256 t = 0; t < 7; t++) {
                uint256 sz = c.bits[t] + _colLog(t);
                if (sz == b - 1) {
                    c.advSel[t] = off >> sz;
                    off += 1 << sz;
                }
            }
        }
        uint256 a = GkrMath.log2ceil(off);
        if (2 + c.bits[5] > a) a = 2 + c.bits[5];
        if (3 + c.bits[4] > a) a = 3 + c.bits[4];
        c.a = a;
    }

    // ------------------------------------------------------------------ transcript

    function _absorbStatement(Ctx memory c, Statement calldata st, uint256[] calldata proof) internal view {
        uint256[] memory w = new uint256[](st.mode == 2 ? 24 : 22);
        w[0] = 1;
        w[1] = st.mode;
        w[2] = uint256(st.sessionDigest);
        w[3] = st.n;
        w[4] = st.duration;
        w[5] = st.m;
        w[6] = st.chartBits;
        w[7] = st.components;
        for (uint256 i = 0; i < 4; i++) {
            w[8 + i] = st.laneBits[i];
        }
        for (uint256 i = 0; i < 5; i++) {
            w[12 + i] = st.counts[i];
        }
        // w[17] (srsId) set by caller context below
        w[18] = st.chartCommitment[0];
        w[19] = st.chartCommitment[1];
        uint256 k = 20;
        if (st.mode == 2) {
            w[20] = st.traceCommitment[0];
            w[21] = st.traceCommitment[1];
            k = 22;
        }
        w[k] = proof[0];
        w[k + 1] = proof[1];
        c.pos = 2;
        _absorbStatementWords(c, w);
    }

    function _absorbStatementWords(Ctx memory c, uint256[] memory w) internal view {
        w[17] = uint256(srsId);
        _absorbMem(c, w);
    }

    function _absorbMem(Ctx memory c, uint256[] memory w) internal pure {
        bytes32 s = c.s;
        assembly ("memory-safe") {
            let len := mload(w)
            let ptr := mload(0x40)
            mstore(ptr, s)
            let src := add(w, 32)
            for { let i := 0 } lt(i, len) { i := add(i, 1) } {
                mstore(add(ptr, mul(add(i, 1), 32)), mload(add(src, mul(i, 32))))
            }
            s := keccak256(ptr, mul(add(len, 1), 32))
        }
        c.s = s;
    }

    /// Absorbs proof[start .. start+count) (already range-checked by the caller).
    function _absorbCd(Ctx memory c, uint256[] calldata proof, uint256 start, uint256 count) internal pure {
        bytes32 s = c.s;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, s)
            calldatacopy(add(ptr, 32), add(proof.offset, mul(start, 32)), mul(count, 32))
            s := keccak256(ptr, mul(add(count, 1), 32))
        }
        c.s = s;
    }

    function _squeeze(Ctx memory c) internal pure returns (uint256 x) {
        bytes32 s = c.s;
        assembly ("memory-safe") {
            mstore(0, s)
            s := keccak256(0, 32)
        }
        c.s = s;
        x = uint256(s) % R;
    }

    function _fe(Ctx memory c, uint256[] calldata proof) internal pure returns (uint256 x) {
        x = proof[c.pos++];
        require(x < R, "non-canonical field element");
    }

    // ------------------------------------------------------------------ small math

    // ------------------------------------------------------------------ GKR

    /// Fractional-sum GKR (SPEC §7.2 step 3), in Yul: per round 3 words, per layer 4 child words.
    function _gkr(Ctx memory c, uint256[] calldata proof) internal pure {
        uint256 g = c.g;
        uint256 pos = c.pos;
        // Words needed: 4 + Σ_{k=1}^{g-1} (3k + 4)
        require(pos + 4 + (3 * g * (g - 1)) / 2 + 4 * (g - 1) <= proof.length, "proof too short");
        uint256[] memory point = new uint256[](g);
        uint256[] memory rho = new uint256[](g);
        bytes32 s = c.s;
        uint256 cp;
        uint256 cq;
        uint256 err;
        assembly ("memory-safe") {
            let m := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
            let scratch := mload(0x40)
            // s ← keccak(s ‖ proof[p .. p+k)), then s ← keccak(s); returns new s
            function absorbSqueeze(st, src, k, buf) -> ns {
                mstore(buf, st)
                calldatacopy(add(buf, 32), src, mul(k, 32))
                ns := keccak256(buf, add(32, mul(k, 32)))
                mstore(buf, ns)
                ns := keccak256(buf, 32)
            }
            function squeezeOnly(st, buf) -> ns {
                mstore(buf, st)
                ns := keccak256(buf, 32)
            }
            function interp4(e0, e1, e2, e3, x) -> r {
                let q := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                let i2 := 10944121435919637611123202872628637544274182200208017171849102093287904247809
                let i6 := 18240202393199396018538671454381062573790303667013361953081836822146507079681
                let x1 := addmod(x, sub(q, 1), q)
                let x2 := addmod(x, sub(q, 2), q)
                let x3 := addmod(x, sub(q, 3), q)
                let a := mulmod(x1, x2, q)
                let b := mulmod(x, x3, q)
                // L0 = −(x−1)(x−2)(x−3)/6, L1 = x(x−2)(x−3)/2, L2 = −x(x−1)(x−3)/2, L3 = x(x−1)(x−2)/6
                r := mulmod(e0, sub(q, mulmod(mulmod(a, x3, q), i6, q)), q)
                r := addmod(r, mulmod(e1, mulmod(mulmod(b, x2, q), i2, q), q), q)
                r := addmod(r, mulmod(e2, sub(q, mulmod(mulmod(b, x1, q), i2, q)), q), q)
                r := addmod(r, mulmod(e3, mulmod(mulmod(a, x, q), i6, q), q), q)
            }
            function eq1(a, b) -> r {
                let q := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                r := addmod(addmod(mulmod(2, mulmod(a, b, q), q), sub(q, a), q), addmod(sub(q, b), 1, q), q)
            }
            let base := proof.offset
            let src := add(base, mul(pos, 32))
            let w0 := calldataload(src)
            let w1 := calldataload(add(src, 32))
            let w2 := calldataload(add(src, 64))
            let w3 := calldataload(add(src, 96))
            if iszero(and(and(lt(w0, m), lt(w1, m)), and(lt(w2, m), lt(w3, m)))) { err := 1 }
            if addmod(mulmod(w0, w3, m), mulmod(w1, w2, m), m) { err := 2 }
            if iszero(mulmod(w2, w3, m)) { err := 3 }
            s := absorbSqueeze(s, src, 4, scratch)
            pos := add(pos, 4)
            let tau := mod(s, m)
            let pp := add(point, 32)
            let rp := add(rho, 32)
            mstore(pp, tau)
            cp := addmod(w0, mulmod(tau, addmod(w1, sub(m, w0), m), m), m)
            cq := addmod(w2, mulmod(tau, addmod(w3, sub(m, w2), m), m), m)
            for { let k := 1 } lt(k, g) { k := add(k, 1) } {
                s := squeezeOnly(s, scratch)
                let lambda := mod(s, m)
                let claim := addmod(cp, mulmod(lambda, cq, m), m)
                let eqacc := 1
                for { let j := 0 } lt(j, k) { j := add(j, 1) } {
                    src := add(base, mul(pos, 32))
                    let e0 := calldataload(src)
                    let e2 := calldataload(add(src, 32))
                    let e3 := calldataload(add(src, 64))
                    if iszero(and(lt(e0, m), and(lt(e2, m), lt(e3, m)))) { err := 1 }
                    s := absorbSqueeze(s, src, 3, scratch)
                    pos := add(pos, 3)
                    let x := mod(s, m)
                    claim := interp4(e0, addmod(claim, sub(m, e0), m), e2, e3, x)
                    mstore(add(rp, mul(j, 32)), x)
                    eqacc := mulmod(eqacc, eq1(mload(add(pp, mul(j, 32))), x), m)
                }
                src := add(base, mul(pos, 32))
                w0 := calldataload(src)
                w1 := calldataload(add(src, 32))
                w2 := calldataload(add(src, 64))
                w3 := calldataload(add(src, 96))
                if iszero(and(and(lt(w0, m), lt(w1, m)), and(lt(w2, m), lt(w3, m)))) { err := 1 }
                let inner := addmod(addmod(mulmod(w0, w3, m), mulmod(w1, w2, m), m), mulmod(lambda, mulmod(w2, w3, m), m), m)
                if iszero(eq(claim, mulmod(eqacc, inner, m))) { err := 4 }
                s := absorbSqueeze(s, src, 4, scratch)
                pos := add(pos, 4)
                tau := mod(s, m)
                // new point = (tau, rho_0..rho_{k-1})
                for { let j := k } gt(j, 0) { j := sub(j, 1) } {
                    mstore(add(pp, mul(j, 32)), mload(add(rp, mul(sub(j, 1), 32))))
                }
                mstore(pp, tau)
                cp := addmod(w0, mulmod(tau, addmod(w1, sub(m, w0), m), m), m)
                cq := addmod(w2, mulmod(tau, addmod(w3, sub(m, w2), m), m), m)
            }
        }
        require(err != 1, "non-canonical field element");
        require(err != 2, "fractional sum not zero");
        require(err != 3, "zero denominator");
        require(err == 0, "GKR layer check failed");
        c.s = s;
        c.pos = pos;
        c.z = point;
        c.p = cp;
        c.q = cq;
    }

    /// Reads k ≤ 4 words at c.pos (canonical), absorbs them and squeezes the round challenge.
    function _round(Ctx memory c, uint256[] calldata proof, uint256 k) internal pure returns (uint256[4] memory e, uint256 x) {
        uint256 pos = c.pos;
        require(pos + k <= proof.length, "proof too short");
        bytes32 s = c.s;
        assembly ("memory-safe") {
            let base := add(proof.offset, mul(pos, 32))
            calldatacopy(e, base, mul(k, 32))
            let ptr := mload(0x40)
            mstore(ptr, s)
            calldatacopy(add(ptr, 32), base, mul(k, 32))
            s := keccak256(ptr, add(32, mul(k, 32)))
            mstore(0, s)
            s := keccak256(0, 32)
        }
        require(e[0] < R && e[1] < R && e[2] < R && e[3] < R, "non-canonical field element");
        c.s = s;
        c.pos = pos + k;
        x = uint256(s) % R;
    }

    function _rowRound(Ctx memory c, uint256[] calldata proof, uint256 claim, uint256[5] memory e)
        internal
        pure
        returns (uint256, uint256)
    {
        (uint256[4] memory w, uint256 x) = _round(c, proof, 4);
        e[0] = w[0];
        e[1] = addmod(claim, R - w[0], R);
        e[2] = w[1];
        e[3] = w[2];
        e[4] = w[3];
        return (GkrMath.interp5(e, x), x);
    }


    // ------------------------------------------------------------------ row sumcheck

    function _rowSumcheck(Ctx memory c, uint256[] calldata proof, Statement calldata st) internal view {
        c.lambda = _squeeze(c);
        uint256 beta = _squeeze(c);
        uint256 zeta = _squeeze(c);
        uint256 kappa = _squeeze(c);
        uint256 rmax = c.rmax;
        c.r = new uint256[](rmax);
        for (uint256 j = 0; j < rmax; j++) {
            c.r[j] = _squeeze(c);
        }
        uint256 sumChi;
        for (uint256 t = 0; t < 7; t++) {
            uint256 ns = _slots(t);
            c.chi[t] = new uint256[](ns);
            for (uint256 s = 0; s < ns; s++) {
                uint256 v = GkrMath.eqConst(c.leafBase[t] + s, c.z, c.bits[t], c.g);
                c.chi[t][s] = v;
                sumChi = addmod(sumChi, v, R);
            }
        }
        uint256 claim;
        {
            uint256 zp = kappa;
            uint256 countClaim;
            for (uint256 i = 0; i < 5; i++) {
                c.kz[i] = zp;
                countClaim = addmod(countClaim, mulmod(zp, st.counts[i], R), R);
                zp = mulmod(zp, zeta, R);
            }
            uint256 unused = addmod(1, R - sumChi, R);
            claim = addmod(addmod(c.p, mulmod(c.lambda, addmod(c.q, R - unused, R), R), R), countClaim, R);
        }
        c.rp = new uint256[](rmax);
        uint256[5] memory e;
        for (uint256 j = 0; j < rmax; j++) {
            (claim, c.rp[j]) = _rowRound(c, proof, claim, e);
        }
        uint256 claimStart = c.pos;
        for (uint256 i = 0; i < N_CLAIMS; i++) {
            require(proof[claimStart + i] < R, "non-canonical field element");
        }
        _absorbCd(c, proof, claimStart, N_CLAIMS);
        c.pos = claimStart + N_CLAIMS;
        require(claim == _rowPoly(c, proof, claimStart, st, beta), "row sumcheck final check failed");
    }

    function _rowPoly(Ctx memory c, uint256[] calldata proof, uint256 claimStart, Statement calldata st, uint256 beta)
        internal
        view
        returns (uint256)
    {
        GkrRelation.Input memory inp;
        inp.bits = c.bits;
        inp.r = c.r;
        inp.rp = c.rp;
        inp.z = c.z;
        inp.chi = new uint256[](74);
        uint256 k;
        for (uint256 t = 0; t < 7; t++) {
            for (uint256 s = 0; s < c.chi[t].length; s++) {
                inp.chi[k++] = c.chi[t][s];
            }
        }
        inp.claims = proof[claimStart:claimStart + N_CLAIMS];
        inp.al = c.al;
        inp.gamma = c.gamma;
        inp.lambda = c.lambda;
        inp.beta = beta;
        inp.kz = c.kz;
        inp.m = st.m;
        inp.n = st.n;
        inp.duration = st.duration;
        return relation.rowPoly(inp);
    }

    // ------------------------------------------------------------------ reduction + opening

    function _reductionAndOpening(Ctx memory c, uint256[] calldata proof, Statement calldata st, bytes calldata events)
        internal
        view
    {
        uint256[3] memory ev = _reduction(c, proof, st, events);
        _opening(c, proof, st, ev);
    }

    /// Opening-reduction sumcheck; returns [ADV(z*), CHART(z*), TRACE(z*)].
    function _reduction(Ctx memory c, uint256[] calldata proof, Statement calldata st, bytes calldata events)
        internal
        pure
        returns (uint256[3] memory ev)
    {
        uint256 mu = _squeeze(c);
        uint256 red = _claimsCombination(proof, c.pos - N_CLAIMS, mu);
        c.zs = new uint256[](c.a);
        for (uint256 j = 0; j < c.a; j++) {
            (red, c.zs[j]) = _reductionRound(c, proof, red);
        }
        uint256[3] memory wts = _weights(c, mu);
        uint256 finalsStart = c.pos;
        ev[0] = _fe(c, proof);
        ev[1] = _fe(c, proof);
        if (st.mode == 2) {
            ev[2] = _fe(c, proof);
        } else {
            require(events.length == uint256(st.n) * 14, "trace length mismatch");
            ev[2] = _traceMle(c, events, st.n);
        }
        uint256 expected = addmod(mulmod(ev[0], wts[0], R), mulmod(ev[1], wts[1], R), R);
        require(red == addmod(expected, mulmod(ev[2], wts[2], R), R), "opening reduction failed");
        _absorbCd(c, proof, finalsStart, st.mode == 2 ? 3 : 2);
    }

    function _claimsCombination(uint256[] calldata proof, uint256 start, uint256 mu) internal pure returns (uint256 red) {
        uint256 mp = 1;
        for (uint256 i = 0; i < N_CLAIMS; i++) {
            red = addmod(red, mulmod(mp, proof[start + i], R), R);
            mp = mulmod(mp, mu, R);
        }
    }

    /// Batched Zeromorph opening of ADV + ν·CHART (+ ν²·TRACE) at z*.
    function _opening(Ctx memory c, uint256[] calldata proof, Statement calldata st, uint256[3] memory ev)
        internal
        view
    {
        uint256 nu = _squeeze(c);
        uint256 value = addmod(ev[0], mulmod(nu, ev[1], R), R);
        uint256[3][] memory terms = new uint256[3][](st.mode == 2 ? 3 : 2);
        terms[0] = [proof[0], proof[1], 1];
        terms[1] = [st.chartCommitment[0], st.chartCommitment[1], nu];
        if (st.mode == 2) {
            uint256 nu2 = mulmod(nu, nu, R);
            value = addmod(value, mulmod(nu2, ev[2], R), R);
            terms[2] = [st.traceCommitment[0], st.traceCommitment[1], nu2];
        }
        _zeromorph(c, proof, terms, value);
    }

    function _reductionRound(Ctx memory c, uint256[] calldata proof, uint256 claim) internal pure returns (uint256, uint256) {
        (uint256[4] memory e, uint256 x) = _round(c, proof, 2);
        return (GkrMath.interp3(e[0], addmod(claim, R - e[0], R), e[1], x), x);
    }

    /// W_A, W_N, W_E at z* (SPEC §7.2 step 5).
    function _weights(Ctx memory c, uint256 mu) internal pure returns (uint256[3] memory w) {
        uint256[2] memory mp = [uint256(1), mu]; // [μ^i, μ]
        for (uint256 t = 0; t < 7; t++) {
            _weightsTable(c, t, mp, w);
        }
    }

    function _weightsTable(Ctx memory c, uint256 t, uint256[2] memory mp, uint256[3] memory w) internal pure {
        uint256[] memory zs = c.zs;
        uint256 bits = c.bits[t];
        uint256 hi = bits + _colLog(t);
        uint256 common = mulmod(GkrMath.eqConst(c.advSel[t], zs, hi, zs.length), GkrMath.eqArr(c.rp, zs, 0, bits), R);
        uint256 nAdv = t < 4 ? 23 : (t == 4 ? 32 : (t == 5 ? 5 : 1));
        for (uint256 col = 0; col < nAdv; col++) {
            w[0] = addmod(w[0], mulmod(mp[0], mulmod(common, GkrMath.eqConst(col, zs, bits, hi), R), R), R);
            mp[0] = mulmod(mp[0], mp[1], R);
        }
        if (t == 4 || t == 5) {
            uint256 sl = t == 4 ? 3 : 2;
            uint256 nSrc = t == 4 ? 5 : 3;
            uint256 rowTerm = mulmod(GkrMath.eqArr(c.rp, zs, sl, bits), GkrMath.pad(zs, sl + bits), R);
            for (uint256 col = 0; col < nSrc; col++) {
                uint256 term = mulmod(mp[0], mulmod(GkrMath.eqConst(col, zs, 0, sl), rowTerm, R), R);
                w[t == 4 ? 1 : 2] = addmod(w[t == 4 ? 1 : 2], term, R);
                mp[0] = mulmod(mp[0], mp[1], R);
            }
        }
    }

    /// Mode A: MLE of the row-major TRACE vector (t, lane, act, 0 per event) at z*.
    function _traceMle(Ctx memory c, bytes calldata events, uint256 n) internal pure returns (uint256) {
        if (n == 0) return 0;
        uint256[] memory zs = c.zs;
        uint256 bits = c.bits[5];
        require(zs.length >= 2 + bits && events.length >= 14 * n, "trace shape");
        uint256[3] memory ec = [
            mulmod(addmod(1, R - zs[0], R), addmod(1, R - zs[1], R), R),
            mulmod(zs[0], addmod(1, R - zs[1], R), R),
            mulmod(addmod(1, R - zs[0], R), zs[1], R)
        ];
        uint256 len = (n + 1) / 2;
        uint256[] memory buf = new uint256[](len);
        assembly ("memory-safe") {
            function ev(off, a0, a1, a2) -> v {
                let m := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                let w := calldataload(off)
                v := addmod(mulmod(a0, and(shr(160, w), 0xffffffffffffffff), m), mulmod(a1, and(shr(152, w), 0xff), m), m)
                v := addmod(v, mulmod(a2, and(shr(144, w), 0xff), m), m)
            }
            function fold(lo, hi, y) -> v {
                let m := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
                v := addmod(lo, mulmod(y, addmod(hi, sub(m, lo), m), m), m)
            }
            let e0 := mload(ec)
            let e1 := mload(add(ec, 32))
            let e2 := mload(add(ec, 64))
            let bp := add(buf, 32)
            let y0 := mload(add(zs, 96)) // zs[2]
            for { let i := 0 } lt(i, len) { i := add(i, 1) } {
                let j := mul(i, 2)
                let lo := ev(add(events.offset, mul(j, 14)), e0, e1, e2)
                let hi := 0
                if lt(add(j, 1), n) { hi := ev(add(events.offset, mul(add(j, 1), 14)), e0, e1, e2) }
                mstore(add(bp, mul(i, 32)), fold(lo, hi, y0))
            }
        }
        _foldInPlace(buf, len, zs, 3, bits - 1);
        return mulmod(buf[0], GkrMath.pad(zs, 2 + bits), R);
    }

    /// Folds buf[0..len) by variables x[from .. from+count) (zero beyond len).
    function _foldInPlace(uint256[] memory buf, uint256 len, uint256[] memory x, uint256 from, uint256 count)
        internal
        pure
    {
        require(from + count <= x.length && len <= buf.length, "fold bounds");
        assembly ("memory-safe") {
            let bp := add(buf, 32)
            let xp := add(add(x, 32), mul(from, 32))
            for { let jj := 0 } lt(jj, count) { jj := add(jj, 1) } {
                let y := mload(add(xp, mul(jj, 32)))
                let next := div(add(len, 1), 2)
                for { let i := 0 } lt(i, next) { i := add(i, 1) } {
                    let k := mul(i, 2)
                    let lo := mload(add(bp, mul(k, 32)))
                    let hi := 0
                    if lt(add(k, 1), len) { hi := mload(add(bp, mul(add(k, 1), 32))) }
                    mstore(add(bp, mul(i, 32)), addmod(lo, mulmod(y, addmod(hi, sub(R, lo), R), R), R))
                }
                len := next
            }
        }
    }

    // ------------------------------------------------------------------ chart registration (SPEC §8.1)

    struct ChartInfo {
        bytes32 chartHash;
        uint64 m;
        uint8 bits;
        uint64 components;
        uint64 maxEnd;
    }

    /// Validates SP1-canonical chart bytes, computes chartHash and checks that `commitment`
    /// is the row-major CHART commitment by opening it at a Fiat–Shamir point.
    function checkChart(bytes calldata chart, uint256[2] calldata commitment, uint256[] calldata proof)
        external
        view
        returns (ChartInfo memory info)
    {
        require(chart.length >= 24, "short chart");
        require(bytes17(chart[0:17]) == bytes17("OSUMANIA_CHART_V1"), "bad chart domain");
        require(uint16(bytes2(chart[17:19])) == 1 && uint8(chart[19]) == 4, "bad chart version");
        uint256 m = uint32(bytes4(chart[20:24]));
        require(m >= 1 && m <= MAX_NOTES && chart.length == 24 + 17 * m, "bad chart size");
        info.chartHash = sha256(chart);
        info.m = uint64(m);
        uint256 bits = GkrMath.log2ceil(m);
        info.bits = uint8(bits);
        Ctx memory c;
        c.s = keccak256("OSUMANIA_GKR_CHART_V1");
        {
            uint256[] memory w = new uint256[](3);
            (w[0], w[1], w[2]) = (uint256(info.chartHash), commitment[0], commitment[1]);
            _absorbMem(c, w);
        }
        c.a = 3 + bits;
        require(c.a <= smax, "chart exceeds SRS");
        c.zs = new uint256[](c.a);
        for (uint256 j = 0; j < c.a; j++) {
            c.zs[j] = _squeeze(c);
        }
        uint256 value;
        (value, info.components, info.maxEnd) = _chartMle(chart, m, bits, c.zs);
        {
            uint256[] memory w = new uint256[](1);
            w[0] = value;
            _absorbMem(c, w);
        }
        uint256[3][] memory terms = new uint256[3][](1);
        terms[0] = [commitment[0], commitment[1], 1];
        _zeromorph(c, proof, terms, value);
        require(c.pos == proof.length, "trailing proof words");
    }

    /// Validates V1 chart rules while folding the row-major MLE (slots lane, s, e, hold, kl).
    function _chartMle(bytes calldata chart, uint256 m, uint256 bits, uint256[] memory u)
        internal
        pure
        returns (uint256 value, uint64 components, uint64 maxEnd)
    {
        uint256[5] memory ec;
        for (uint256 col = 0; col < 5; col++) {
            ec[col] = GkrMath.eqConst(col, u, 0, 3);
        }
        uint256[] memory buf = new uint256[](m);
        uint256[4] memory laneEnd;
        uint256[4] memory laneCount;
        bool[4] memory laneSeen;
        uint256 prevKey;
        for (uint256 k = 0; k < m; k++) {
            uint256 word;
            assembly ("memory-safe") {
                word := calldataload(add(add(chart.offset, 24), mul(k, 17)))
            }
            uint256 lane = word >> 248;
            uint256 s = (word >> 184) & 0xffffffffffffffff;
            uint256 e = (word >> 120) & 0xffffffffffffffff;
            require(lane < 4 && s <= e && e <= MAX_DURATION - W, "invalid note");
            uint256 key = (s << 8) | lane;
            require(k == 0 || key > prevKey, "chart not sorted");
            prevKey = key;
            require(!laneSeen[lane] || s > laneEnd[lane], "same-lane overlap");
            laneSeen[lane] = true;
            laneEnd[lane] = e;
            uint256 hold = e > s ? 1 : 0;
            components += uint64(1 + hold);
            if (e > maxEnd) maxEnd = uint64(e);
            uint256 v = addmod(mulmod(ec[0], lane, R), mulmod(ec[1], s, R), R);
            v = addmod(v, addmod(mulmod(ec[2], e, R), mulmod(ec[3], hold, R), R), R);
            buf[k] = addmod(v, mulmod(ec[4], laneCount[lane], R), R);
            laneCount[lane]++;
        }
        _foldInPlace(buf, m, u, 3, bits);
        value = mulmod(buf[0], GkrMath.pad(u, 3 + bits), R);
    }

    // ------------------------------------------------------------------ Zeromorph (SPEC §7.6)

    function _point(Ctx memory c, uint256[] calldata proof) internal pure returns (uint256 x, uint256 y) {
        x = proof[c.pos];
        y = proof[c.pos + 1];
        c.pos += 2;
    }

    /// Verifies Σ_i mult_i·C_i opens to `value` at c.zs (c.a variables); proof words at c.pos.
    function _zeromorph(Ctx memory c, uint256[] calldata proof, uint256[3][] memory terms, uint256 value)
        internal
        view
    {
        uint256 a = c.a;
        uint256 qStart = c.pos;
        c.pos += 2 * a;
        _absorbCd(c, proof, qStart, 2 * a);
        uint256 y = _squeeze(c);
        _absorbCd(c, proof, c.pos, 4);
        uint256 x = _squeeze(c);
        uint256 zc = _squeeze(c);
        _absorbCd(c, proof, c.pos + 4, 2);
        uint256 rho = _squeeze(c);
        uint256[] memory coeffs = new uint256[](a);
        uint256 constTerm;
        {
            // xp[j] = x^{2^j}, j = 0..a; dens = x^{2^j} − 1 (j ≤ a) and x
            uint256[] memory xp = new uint256[](a + 1);
            uint256 cur = x;
            for (uint256 j = 0; j <= a; j++) {
                xp[j] = cur;
                cur = mulmod(cur, cur, R);
            }
            uint256[] memory inv = new uint256[](a + 2);
            for (uint256 j = 0; j <= a; j++) {
                inv[j] = addmod(xp[j], R - 1, R);
            }
            inv[a + 1] = x;
            _batchInvert(inv);
            uint256 xN = xp[a];
            uint256 xNm1 = addmod(xN, R - 1, R);
            constTerm = mulmod(value, mulmod(xNm1, inv[0], R), R);
            uint256 yPow = 1;
            uint256 xInvPow = inv[a + 1];
            for (uint256 k = 0; k < a; k++) {
                uint256 ck = mulmod(
                    xNm1, addmod(mulmod(xp[k], inv[k + 1], R), R - mulmod(c.zs[k], inv[k], R), R), R
                );
                coeffs[k] = addmod(mulmod(mulmod(yPow, xN, R), xInvPow, R), mulmod(zc, ck, R), R);
                yPow = mulmod(yPow, y, R);
                xInvPow = mulmod(xInvPow, xInvPow, R);
            }
        }
        // lhs = q̂ − Σ coeffs_k q_k + z(C_A + νC_N [+ ν²C_E]) − z·const·G1 + x·π + ρ·q̂'
        (uint256 qhx, uint256 qhy) = (proof[qStart + 2 * a], proof[qStart + 2 * a + 1]);
        (uint256 lx, uint256 ly) = (qhx, qhy);
        for (uint256 k = 0; k < a; k++) {
            (uint256 px, uint256 py) = _ecMul(proof[qStart + 2 * k], proof[qStart + 2 * k + 1], R - coeffs[k]);
            (lx, ly) = _ecAdd(lx, ly, px, py);
        }
        for (uint256 i = 0; i < terms.length; i++) {
            (uint256 px, uint256 py) = _ecMul(terms[i][0], terms[i][1], mulmod(zc, terms[i][2], R));
            (lx, ly) = _ecAdd(lx, ly, px, py);
        }
        {
            uint256 s = mulmod(zc, constTerm, R);
            (uint256 px, uint256 py) = _ecMul(1, 2, s == 0 ? 0 : R - s);
            (lx, ly) = _ecAdd(lx, ly, px, py);
        }
        uint256 piX = proof[qStart + 2 * a + 4];
        uint256 piY = proof[qStart + 2 * a + 5];
        {
            (uint256 px, uint256 py) = _ecMul(piX, piY, x);
            (lx, ly) = _ecAdd(lx, ly, px, py);
            (px, py) = _ecMul(proof[qStart + 2 * a + 2], proof[qStart + 2 * a + 3], rho);
            (lx, ly) = _ecAdd(lx, ly, px, py);
        }
        (uint256 nqx, uint256 nqy) = _ecMul(qhx, qhy, rho == 0 ? 0 : R - rho);
        c.pos = qStart + 2 * a + 6;
        require(_pairing3(lx, ly, piX, piY, nqx, nqy, a), "Zeromorph pairing check failed");
    }

    function _batchInvert(uint256[] memory v) internal view {
        uint256 n = v.length;
        uint256[] memory prefix = new uint256[](n);
        uint256 acc = 1;
        for (uint256 i = 0; i < n; i++) {
            require(v[i] != 0, "degenerate challenge");
            prefix[i] = acc;
            acc = mulmod(acc, v[i], R);
        }
        uint256 inv = _modInv(acc);
        for (uint256 ii = n; ii > 0; ii--) {
            uint256 i = ii - 1;
            uint256 next = mulmod(inv, v[i], R);
            v[i] = mulmod(inv, prefix[i], R);
            inv = next;
        }
    }

    function _modInv(uint256 x) internal view returns (uint256 out) {
        bool ok;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 32)
            mstore(add(p, 32), 32)
            mstore(add(p, 64), 32)
            mstore(add(p, 96), x)
            mstore(add(p, 128), sub(R, 2))
            mstore(add(p, 160), R)
            ok := staticcall(gas(), 5, p, 192, p, 32)
            out := mload(p)
        }
        require(ok, "modexp failed");
    }

    function _ecAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal view returns (uint256 x, uint256 y) {
        bool ok;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, x1)
            mstore(add(p, 32), y1)
            mstore(add(p, 64), x2)
            mstore(add(p, 96), y2)
            ok := staticcall(gas(), 6, p, 128, p, 64)
            x := mload(p)
            y := mload(add(p, 32))
        }
        require(ok, "ecAdd failed");
    }

    function _ecMul(uint256 px, uint256 py, uint256 s) internal view returns (uint256 x, uint256 y) {
        bool ok;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, px)
            mstore(add(p, 32), py)
            mstore(add(p, 64), s)
            ok := staticcall(gas(), 7, p, 96, p, 64)
            x := mload(p)
            y := mload(add(p, 32))
        }
        require(ok, "ecMul failed");
    }

    /// e(L, [1]) · e(−π, [τ]) · e(−ρq̂, shift[a]) == 1
    function _pairing3(uint256 lx, uint256 ly, uint256 piX, uint256 piY, uint256 nqx, uint256 nqy, uint256 a)
        internal
        view
        returns (bool)
    {
        uint256 Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        uint256[18] memory input;
        input[0] = lx;
        input[1] = ly;
        (input[2], input[3], input[4], input[5]) = (g2OneXi, g2OneXr, g2OneYi, g2OneYr);
        input[6] = piX;
        input[7] = piY == 0 ? 0 : Q - piY;
        (input[8], input[9], input[10], input[11]) = (g2TauXi, g2TauXr, g2TauYi, g2TauYr);
        input[12] = nqx;
        input[13] = nqy;
        uint256[4] memory sh = g2Shift[a];
        (input[14], input[15], input[16], input[17]) = (sh[0], sh[1], sh[2], sh[3]);
        uint256[1] memory out;
        bool ok;
        assembly ("memory-safe") {
            ok := staticcall(gas(), 8, input, 576, out, 32)
        }
        return ok && out[0] == 1;
    }
}
