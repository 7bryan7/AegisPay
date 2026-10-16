# Archived browser source

These text files preserve the inherited Hedera landing page, browser wallet,
legacy API client and its excluded wallet test. They are historical reference,
not executable application modules. Their original relative imports are retained.

The active application now opens the Arc accounts-payable dashboard at `/dashboard`.
The unused browser-wallet packages were removed to reduce dependency exposure.
Legacy backend modules/tests remain in place; their retained Hedera SDK dependencies
are pinned to patched versions through root npm overrides.
