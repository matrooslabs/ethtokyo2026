// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GkrRelation} from "../src/GkrRelation.sol";

contract RelationGasTest {
    event log_named_uint(string key, uint256 val);
    uint256 constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function _rand(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(i))) % R;
    }

    function _arr(uint256 n, uint256 seed) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i = 0; i < n; i++) a[i] = _rand(seed + i);
    }

    function testRelationGas() public {
        GkrRelation rel = new GkrRelation();
        GkrRelation.Input memory inp;
        inp.bits = [uint256(12), 12, 12, 12, 12, 13, 8];
        inp.r = _arr(13, 100);
        inp.rp = _arr(13, 200);
        inp.z = _arr(19, 300);
        inp.chi = _arr(74, 400);
        inp.claims = _arr(138, 500);
        for (uint256 i = 0; i < 9; i++) inp.al[i] = _rand(600 + i);
        inp.gamma = _rand(700);
        inp.lambda = _rand(701);
        inp.beta = _rand(702);
        for (uint256 i = 0; i < 5; i++) inp.kz[i] = _rand(710 + i);
        inp.m = 3000;
        inp.n = 6000;
        inp.duration = 451_000_000;
        uint256 g = gasleft();
        rel.rowPoly(inp);
        emit log_named_uint("rowPoly call gas (3000-note shape)", g - gasleft());
    }
}
