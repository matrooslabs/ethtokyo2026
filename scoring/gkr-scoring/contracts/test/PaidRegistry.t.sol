// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {GkrScoreTest} from "./GkrScore.t.sol";
import {TestUSDC} from "./DailyLeaderboard.t.sol";
import {DailyLeaderboard, IEntryToken, IPaidSessionRegistry} from "../src/DailyLeaderboard.sol";
import {ManiaGkrRegistry} from "../src/ManiaGkrRegistry.sol";

contract RejectingLeaderboard {
    ManiaGkrRegistry public immutable registry;
    constructor(ManiaGkrRegistry registry_) { registry = registry_; }
    function enter(bytes32 chart, address player, address device, uint64 expiry) external returns (bytes32) {
        return registry.openPaidSession(chart, player, device, expiry);
    }
    function recordVerifiedScore(bytes32, uint32) external pure { revert("callback rejected"); }
}

contract PaidRegistryTest is GkrScoreTest {
    function _board() internal returns (DailyLeaderboard board, TestUSDC token) {
        token = new TestUSDC();
        board = new DailyLeaderboard(IEntryToken(address(token)), IPaidSessionRegistry(address(registry)));
        registry.setLeaderboard(address(board));
        token.mint(address(this), 10_000_000);
        token.approve(address(board), type(uint256).max);
    }
    function _chartDevice() internal returns (bytes32 chart, address device) {
        chart = _registerChart(_case("demo-a")); device = vm.addr(DEVICE_KEY);
        registry.setDevice(device, BITSTREAM, true);
    }
    function _signed(bytes32 id) internal returns (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof, bytes memory sig) {
        uint256[] memory out = _proveSession(id,"../../fixtures/demo.json","a");
        (sub,proof) = _submission(out);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY,bytes32(out[11]));
        sig = abi.encodePacked(r,s,v);
    }
    function testPaidProofClaimAndRollback() public {
        (DailyLeaderboard board,TestUSDC token) = _board();
        (bytes32 chart,address device) = _chartDevice();
        uint64 day = board.currentDay();
        bytes32 id = board.enter(chart,address(0xBEEF),device,day);
        require(registry.paidSessions(id),"paid binding");
        ManiaGkrRegistry.Session memory session = registry.getSession(id);
        require(session.header.player == address(0xBEEF) && session.header.chartHash == chart && session.mode == 1,"session binding");
        require(session.expiresAt == board.endAt(day),"midnight expiry");
        (ManiaGkrRegistry.Submission memory sub,uint256[] memory proof,bytes memory sig) = _signed(id);
        bytes memory events = _events("demo-a");
        uint256[] memory bad = _copy(proof); bad[0] ^= 1;
        vm.expectRevert(); registry.submitCalldata(id,events,sub,bad,sig);
        require(!registry.getSession(id).consumed,"failed proof consumed");
        (,,,,bool scored) = board.entries(id); require(!scored,"failed proof recorded");
        uint256 beforeGas = gasleft();
        registry.submitCalldata(id,events,sub,proof,sig);
        emit log_named_uint("paid submit execution gas (demo)",beforeGas-gasleft());
        require(registry.getSession(id).consumed,"not consumed");
        (bool exists,uint32 best) = board.records(chart,day,address(0xBEEF));
        require(exists && best == 987500,"verified daily score");
        // A paid unfinished attempt also funds the winner.
        board.enter(chart,address(0xCAFE),device,day);
        vm.warp(board.endAt(day)); board.claim(chart,day);
        require(token.balanceOf(address(0xBEEF)) == 2_000_000,"prize");
    }
    function testPaidDeadlineAndRevocation() public {
        (DailyLeaderboard board,) = _board(); (bytes32 chart,address device) = _chartDevice();
        uint64 day = board.currentDay(); bytes32 id=board.enter(chart,address(0xBEEF),device,day);
        (ManiaGkrRegistry.Submission memory sub,uint256[] memory proof,bytes memory sig)=_signed(id);
        bytes memory events=_events("demo-a");
        registry.setDevice(device,BITSTREAM,false);
        vm.expectRevert(); registry.submitCalldata(id,events,sub,proof,sig);
        registry.setDevice(device,BITSTREAM,true);
        vm.warp(board.endAt(day)); vm.expectRevert(); registry.submitCalldata(id,events,sub,proof,sig);
        require(!registry.getSession(id).consumed,"midnight consumed");
        (,,,,bool scored)=board.entries(id); require(!scored,"midnight recorded");
        board.refund(chart,day);
    }
    function testPaidOpeningFailureAndAuthorization() public {
        (DailyLeaderboard board,TestUSDC token)=_board(); (bytes32 chart,address device)=_chartDevice();
        uint64 day=board.currentDay(); uint64 expiry=uint64(board.endAt(day));
        vm.expectRevert(); registry.openPaidSession(chart,address(this),device,expiry);
        vm.expectRevert(); registry.setLeaderboard(address(board));
        vm.prank(address(board)); vm.expectRevert(); registry.openPaidSession(chart,address(this),device,expiry+1);
        token.setFailure(true); vm.expectRevert(); board.enter(chart,address(this),device,day);
        token.setFailure(false);
        vm.expectRevert(); board.enter(bytes32("unknown"),address(this),device,day);
        registry.setDevice(device,BITSTREAM,false);
        vm.expectRevert(); board.enter(chart,address(this),device,day);
        require(token.balanceOf(address(this))==10_000_000 && token.balanceOf(address(board))==0,"opening rollback");
        (uint256 paid,,,,)=board.rounds(chart,day); require(paid==0,"failed entry pot");
    }
    function testPaidUnpaidCannotWin() public {
        (DailyLeaderboard board,)=_board(); (bytes32 chart,address device)=_chartDevice();
        bytes32 id=registry.openSession(bytes32("unpaid"),chart,address(0xBEEF),device,uint64(block.timestamp+3600),1);
        (ManiaGkrRegistry.Submission memory sub,uint256[] memory proof,bytes memory sig)=_signed(id);
        registry.submitCalldata(id,_events("demo-a"),sub,proof,sig);
        require(registry.getSession(id).consumed && !registry.paidSessions(id),"unpaid path preserved");
        (bool exists,)=board.records(chart,board.currentDay(),address(0xBEEF)); require(!exists,"unpaid won");
    }
    function testPaidWiringRejectsUnauthorizedAndWrongRegistry() public {
        DailyLeaderboard wrong = new DailyLeaderboard(IEntryToken(address(new TestUSDC())), IPaidSessionRegistry(address(new ManiaGkrRegistry(verifier))));
        vm.expectRevert(); registry.setLeaderboard(address(wrong));
        DailyLeaderboard correct = new DailyLeaderboard(IEntryToken(address(new TestUSDC())), IPaidSessionRegistry(address(registry)));
        vm.prank(address(0xBAD)); vm.expectRevert(); registry.setLeaderboard(address(correct));
        require(address(registry.leaderboard()) == address(0), "bad wiring persisted");
        registry.setLeaderboard(address(correct));
    }
    function testPaidCallbackFailureRollsBackVerifiedSession() public {
        RejectingLeaderboard rejecting = new RejectingLeaderboard(registry);
        registry.setLeaderboard(address(rejecting));
        (bytes32 chart,address device)=_chartDevice();
        bytes32 id=rejecting.enter(chart,address(0xBEEF),device,uint64((block.timestamp/1 days+1)*1 days));
        (ManiaGkrRegistry.Submission memory sub,uint256[] memory proof,bytes memory sig)=_signed(id);
        vm.expectRevert(); registry.submitCalldata(id,_events("demo-a"),sub,proof,sig);
        ManiaGkrRegistry.Session memory session=registry.getSession(id);
        require(!session.consumed && session.score==0,"callback must rollback registry");
    }
}
