// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RocketMegapoolManager} from "../../contracts/contract/megapool/RocketMegapoolManager.sol";
import {RocketStorageInterface} from "../../contracts/interface/RocketStorageInterface.sol";
import {RocketMegapoolInterface} from "../../contracts/interface/megapool/RocketMegapoolInterface.sol";
import {RocketNetworkExitInterface} from "../../contracts/interface/network/RocketNetworkExitInterface.sol";
import {BeaconStateVerifierInterface, Validator, VerifiedValidator, VerifiedFinalBalance} from "../../contracts/interface/util/BeaconStateVerifierInterface.sol";
import {RocketStorageMock} from "../helpers/RocketStorageMock.sol";

contract RocketMegapoolGloasProofsTest is Test {
    RocketMegapoolManager manager;
    RocketStorageMock store;
    address constant VERIFIER = address(0x100);
    address constant POOL = address(0x200);
    address constant EXIT = address(0x300);
    bytes pubkey = hex"1234";
    bytes32 constant CREDENTIALS = bytes32(uint256(123));

    function setUp() public {
        vm.warp(100000);
        store = new RocketStorageMock();
        store.setAddress(keccak256("contract.addressbeaconStateVerifier"), VERIFIER);
        store.setAddress(keccak256("contract.addressrocketNetworkExit"), EXIT);
        store.setBool(keccak256(abi.encodePacked("megapool.exists", POOL)), true);
        manager = new RocketMegapoolManager(RocketStorageInterface(address(store)));
        vm.etch(POOL, hex"00");
        vm.etch(EXIT, hex"00");
        vm.mockCall(POOL, abi.encodeWithSignature("getValidatorPubkey(uint32)", 1), abi.encode(pubkey));
        vm.mockCall(POOL, abi.encodeWithSignature("getWithdrawalCredentials()"), abi.encode(CREDENTIALS));
    }

    function testVersionedExitPreservesV15Accounting() public {
        Validator memory validator;
        validator.pubkey = pubkey;
        validator.withdrawalCredentials = CREDENTIALS;
        validator.withdrawableEpoch = 99;
        VerifiedValidator memory verified = VerifiedValidator(42, validator, 3200);
        vm.mockCall(VERIFIER, abi.encodeWithSignature("verifyValidator(uint64,uint256,bytes)", uint64(block.timestamp), 1, hex"abcd"), abi.encode(verified));
        vm.expectCall(POOL, abi.encodeWithSignature("notifyExit(uint32,uint64,uint64)", 1, 99, 100));
        vm.expectCall(EXIT, abi.encodeCall(RocketNetworkExitInterface.notifyMegapoolExit, (POOL, 1)));
        manager.notifyExit(RocketMegapoolInterface(POOL), 1, uint64(block.timestamp), 1, hex"abcd");
    }

    function testVersion2FinalBalancePreservesV15Accounting() public {
        VerifiedFinalBalance memory verified = VerifiedFinalBalance(keccak256(pubkey), CREDENTIALS, 32000000000, 99, 100);
        vm.mockCall(VERIFIER, abi.encodeCall(BeaconStateVerifierInterface.verifyFinalBalance, (uint64(block.timestamp), 2, hex"abcd")), abi.encode(verified));
        vm.expectCall(POOL, abi.encodeWithSignature("notifyFinalBalance(uint32,uint64,address,uint64,uint64)", 1, 32000000000, address(this), 99, 100));
        vm.expectCall(EXIT, abi.encodeCall(RocketNetworkExitInterface.notifyMegapoolFinalBalance, (POOL, 1)));
        manager.notifyFinalBalance(RocketMegapoolInterface(POOL), 1, uint64(block.timestamp), 2, hex"abcd");
    }

    function testRejectsOldProofBeforeCallingVerifier() public {
        vm.expectRevert(bytes("Slot proof too old"));
        manager.notifyFinalBalance(RocketMegapoolInterface(POOL), 1, uint64(block.timestamp - 3601), 2, hex"abcd");
    }
}
