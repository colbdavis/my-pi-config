---
name: crypto-ctf
description: Helps solve cryptography CTF/challenge tasks involving RSA, ECC, lattices, hashes, block/stream ciphers, encodings, randomness bugs, and protocol mistakes. Use when analyzing crypto challenge files or writeups.
---

# Crypto CTF

## Workflow

1. Inventory files and parameters: challenge text, source, ciphertexts, public keys, network endpoint if any.
2. Classify the primitive: encoding, XOR, stream cipher, block mode, hash/MAC, RSA, ECC, lattice, PRNG, protocol.
3. State likely vulnerability and required assumptions.
4. Build the smallest verification script possible.
5. Show the math or reasoning briefly, then recover the flag/plaintext/key.

## Common checks

- Encodings/compression before cryptanalysis.
- XOR reuse, known plaintext, crib dragging.
- ECB patterns, CBC padding/oracle issues, CTR nonce reuse.
- RSA: small e, no padding, shared factors, close primes, Wiener/Boneh-Durfee hints, CRT leaks, partial key exposure.
- ECC: invalid curve, nonce reuse, weak curves, small subgroup, biased k.
- Hash/MAC: length extension, weak comparisons, custom construction flaws.
- RNG: time seeds, linear PRNGs, repeated nonces.

Use Python/Sage-style pseudocode where helpful; run local scripts when files are available.
