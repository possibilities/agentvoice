# AgentVoice icon purchase verification

Verified September 10, 2026 against original Noun Project invoices.

- Microphone #856601 by i cons: one-time purchase, $4.99 USD, paid in full.
- Volume #974802 by i cons: one-time purchase, $4.99 USD, paid in full.
- Total: $9.98 USD. These transactions are not subscriptions.

Sources:
- https://thenounproject.com/icon/microphone-856601/
- https://thenounproject.com/icon/volume-974802/

The license holder's royalty-free license waives attribution for these icons, including modifications, under Noun Project Terms of Use §3(A)(3) and the official icon licensing FAQ. Public source assets and derivatives retain their existing CC BY 3.0 notices; downstream users must satisfy attribution or obtain their own applicable waiver. Boatman Studio assets remain separately attributed. No blanket attribution waiver for forks is asserted.

Original invoice PDFs and matching extracted text are retained privately with verified hashes. No separate license certificate PDF was exposed for these purchases in the inspected history; invoices and published terms are the retained evidence. Private billing documents must not be committed or published.

License references:
- https://thenounproject.com/legal/terms-of-use/#icon-licenses
- https://help.thenounproject.com/hc/en-us/articles/200509798-What-licenses-do-you-offer-for-icons

## Building a licensed distribution

Public builds keep accessible attribution by default. The verified license holder
may set `agentvoice.paidNounIcons=856601,974802` in the gitignored
`android/local.properties`; Gradle generates `BuildConfig.PAID_NOUN_ICONS` for
that local build. This removes the selected i cons pair's app Credits action.
It does not remove the public sources, packaged CC BY notices, or Studio's
all-library credits. The flag is a distributor assertion, not a license grant.
Do not copy another distributor's opt-in into a fork without an applicable license.
