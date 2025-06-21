"""
Bittensor Mnemonic to Hex Converter for Subnet 77

This script takes a mnemonic for a root account and correctly extracts
the 32-BYTE SEED as a clean hexadecimal string.

Requires:
- substrateinterface
- python3
- pip install substrateinterface
"""

import sys
from substrateinterface import Keypair
from substrateinterface.exceptions import SubstrateRequestException

def main():
    """Main function to create the keypair and extract the correct seed."""
    try:
        # Prompt for the mnemonic phrase
        mnemonic = input("Enter your 12 or 24-word mnemonic phrase: ").strip()

        if not mnemonic:
            print("\nError: Mnemonic cannot be empty.", file=sys.stderr)
            sys.exit(1)

        print("\nGenerating root keypair from mnemonic...")

        # Create the keypair directly from the mnemonic (no derivation)
        keypair = Keypair.create_from_mnemonic(mnemonic)

        # Get the 32-byte seed object and convert it to a hex string.
        secret_seed_hex_string = keypair.seed_hex.hex()

        print(f"\nYour Address: {keypair.ss58_address}")
        print("   (Verify this matches your correct coldkey address)")
        
        print("\nUSE THIS 32-BYTE SEED FOR VOTING (scripts/vote.ts)")
        print("="*55)
        print(f"  HOLDER_COLDKEY: 0x{secret_seed_hex_string}")
        print("="*55)
        print("   (Copy this entire '0x...' string into your .env file)")


    except (SubstrateRequestException, ValueError) as e:
        print(f"\nError: Invalid mnemonic phrase provided. Please check for typos.", file=sys.stderr)
        print(f"   Details: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
