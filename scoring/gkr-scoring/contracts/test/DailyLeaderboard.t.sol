// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {DailyLeaderboard, IEntryToken, IPaidSessionRegistry} from "../src/DailyLeaderboard.sol";
interface LeaderboardVm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
}
contract TestUSDC {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public fail;
    bool public shortPay;
    address public callback;
    bytes public callbackData;
    bool public callbackSucceeded;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function setFailure(bool value) external { fail = value; }
    function setShortPay(bool value) external { shortPay = value; }
    function setCallback(address target, bytes calldata data) external { callback = target; callbackData = data; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += shortPay ? amount - 1 : amount;
        if (callback != address(0)) (callbackSucceeded,) = callback.call(callbackData);
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (callback != address(0)) (callbackSucceeded,) = callback.call(callbackData);
        return true;
    }
}
contract MockPaidRegistry is IPaidSessionRegistry {
    uint256 public nonce;
    bool public fail;
    bool public reuse;
    function setFailure(bool value) external { fail = value; }
    function setReuse(bool value) external { reuse = value; }
    function openPaidSession(bytes32, address, address, uint64) external returns(bytes32) {
        require(!fail, "opening failed");
        if (reuse) return bytes32(uint256(1));
        return bytes32(++nonce);
    }
    function record(DailyLeaderboard board, bytes32 id, uint32 score) external { board.recordVerifiedScore(id, score); }
}
contract DailyLeaderboardTest {
    LeaderboardVm constant vm = LeaderboardVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC token;
    MockPaidRegistry registry;
    DailyLeaderboard board;
    address constant A = address(0xA);
    address constant B = address(0xB);
    address constant DEVICE = address(0xD);
    bytes32 constant CHART = bytes32(uint256(1));
    bytes32 constant OTHER = bytes32(uint256(2));
    uint64 constant DAY = 20;
    function setUp() public {
        vm.warp(uint256(DAY) * 1 days + 100);
        token = new TestUSDC(); registry = new MockPaidRegistry();
        board = new DailyLeaderboard(IEntryToken(address(token)), registry);
        token.mint(A, 100_000_000); token.mint(B, 100_000_000);
        vm.prank(A); token.approve(address(board), type(uint256).max);
        vm.prank(B); token.approve(address(board), type(uint256).max);
    }
    function enter(address payer, address player, bytes32 chart, uint64 day) internal returns(bytes32 id) {
        vm.prank(payer); return board.enter(chart, player, DEVICE, day);
    }
    function score(bytes32 id, uint32 value) internal { registry.record(board, id, value); }
    function closed() internal { vm.warp((uint256(DAY) + 1) * 1 days); }
    function testZeroScoreTieAndRepeatedAttempts() public {
        bytes32 a = enter(A,A,CHART,DAY); bytes32 b = enter(B,B,CHART,DAY);
        score(a,0); score(b,0);
        (,,address leader,uint32 high,) = board.rounds(CHART,DAY);
        require(leader == A && high == 0, "zero/tie leader");
        (bool exists,uint32 best) = board.records(CHART,DAY,B);
        require(exists && best == 0, "zero record");
        score(enter(B,B,CHART,DAY),30); score(enter(B,B,CHART,DAY),10);
        score(enter(A,A,CHART,DAY),30);
        (,,leader,high,) = board.rounds(CHART,DAY);
        (,best) = board.records(CHART,DAY,B);
        require(leader == B && high == 30 && best == 30, "best and tie");
    }
    function testPayerAndPlayerClaimDestination() public {
        score(enter(A,B,CHART,DAY),99); enter(A,A,CHART,DAY);
        vm.expectRevert(); board.claim(CHART,DAY);
        closed(); board.claim(CHART,DAY);
        require(token.balanceOf(B) == 102_000_000, "winner receives all");
        require(token.balanceOf(A) == 98_000_000, "payer distinct");
        vm.expectRevert(); board.claim(CHART,DAY);
        vm.expectRevert(); vm.prank(A); board.refund(CHART,DAY);
    }
    function testRefundAggregatesOnlyPayersPayments() public {
        enter(A,B,CHART,DAY); enter(A,B,CHART,DAY); enter(B,A,CHART,DAY);
        vm.expectRevert(); vm.prank(A); board.refund(CHART,DAY);
        closed(); vm.prank(A); board.refund(CHART,DAY);
        require(token.balanceOf(A)==100_000_000 && token.balanceOf(B)==99_000_000,"payer refund");
        vm.expectRevert(); vm.prank(A); board.refund(CHART,DAY);
        vm.prank(B); board.refund(CHART,DAY);
        (uint256 paid,uint256 refunded,,,) = board.rounds(CHART,DAY);
        require(paid == refunded && refunded == 3_000_000 && token.balanceOf(address(board))==0,"refund conservation");
        vm.expectRevert(); board.claim(CHART,DAY);
    }
    function testStrictMidnightAndStaleDay() public {
        bytes32 old = enter(A,A,CHART,DAY);
        vm.warp((uint256(DAY)+1)*1 days-1); score(enter(B,B,CHART,DAY),12);
        closed(); vm.expectRevert(); score(old,100);
        vm.expectRevert(); enter(A,A,CHART,DAY);
        bytes32 next = enter(A,A,CHART,DAY+1); score(next,20);
        board.claim(CHART,DAY);
        require(token.balanceOf(address(board))==1_000_000,"tomorrow reserved");
        (,,address leader,uint32 high,) = board.rounds(CHART,DAY+1);
        require(leader == A && high == 20,"tomorrow record");
    }
    function testUnknownUnauthorizedReplay() public {
        bytes32 id = enter(A,A,CHART,DAY);
        vm.expectRevert(); board.recordVerifiedScore(id,5);
        vm.expectRevert(); score(bytes32(uint256(999)),5);
        score(id,5); vm.expectRevert(); score(id,6);
    }
    function testPaymentAndSessionFailureAreAtomic() public {
        token.setFailure(true); vm.expectRevert(); enter(A,A,CHART,DAY);
        token.setFailure(false); token.setShortPay(true); vm.expectRevert(); enter(A,A,CHART,DAY);
        token.setShortPay(false); registry.setFailure(true); vm.expectRevert(); enter(A,A,CHART,DAY);
        require(token.balanceOf(A)==100_000_000 && token.balanceOf(address(board))==0 && registry.nonce()==0,"rolled back");
        (uint256 paid,,,,) = board.rounds(CHART,DAY); require(paid==0,"no pot");
        registry.setFailure(false); enter(A,A,CHART,DAY); registry.setReuse(true);
        vm.expectRevert(); enter(A,A,CHART,DAY);
        require(token.balanceOf(address(board))==1_000_000,"duplicate rolls back");
    }
    function testSettlementFailureCanRetry() public {
        score(enter(A,A,CHART,DAY),10); enter(B,B,OTHER,DAY); closed();
        token.setFailure(true); vm.expectRevert(); board.claim(CHART,DAY);
        vm.expectRevert(); vm.prank(B); board.refund(OTHER,DAY);
        (,,,,bool claimed) = board.rounds(CHART,DAY); require(!claimed,"claim rollback");
        require(board.refundablePayments(OTHER,DAY,B)==1_000_000,"refund rollback");
        token.setFailure(false); board.claim(CHART,DAY); vm.prank(B); board.refund(OTHER,DAY);
        require(token.balanceOf(address(board))==0,"settled");
    }
    function testReentrancyBlockedOnPaymentAndClaim() public {
        token.setCallback(address(board), abi.encodeCall(DailyLeaderboard.enter,(CHART,A,DEVICE,DAY)));
        bytes32 id = enter(A,A,CHART,DAY); require(!token.callbackSucceeded(),"entry reentered");
        score(id,10); closed();
        token.setCallback(address(board),abi.encodeCall(DailyLeaderboard.claim,(CHART,DAY)));
        board.claim(CHART,DAY); require(!token.callbackSucceeded(),"claim reentered");
        require(token.balanceOf(A)==100_000_000,"one payment");
    }
    function testFuzzIsolatedPotsConserveFunds(uint8 a, uint8 b) public {
        uint256 n=uint256(a)%10+1; uint256 m=uint256(b)%10+1;
        bytes32 first;
        for(uint256 i;i<n;i++) { bytes32 id=enter(A,A,CHART,DAY); if(i==0) first=id; }
        for(uint256 i;i<m;i++) enter(B,B,OTHER,DAY);
        score(first,1); closed(); board.claim(CHART,DAY);
        require(token.balanceOf(address(board))==m*1_000_000,"other pot isolated");
        vm.prank(B); board.refund(OTHER,DAY);
        require(token.balanceOf(address(board))==0 && token.balanceOf(A)+token.balanceOf(B)==200_000_000,"conservation");
    }
}
