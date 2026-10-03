# Review criteria

Review the current uncommitted implementation against `spec.md`. Read the source
and tests, then run `python3 -m unittest -v` yourself. Check the behavior rather
than relying solely on the implementation report.

- A failed requirement or reproducible incorrect result is blocking.
- Missing essential coverage for an identified defect is blocking; explain the
  concrete input and expected result.
- Style preferences, speculative generalizations, and unnecessary abstractions
  are advisory and do not prevent approval.
- Do not request support for non-string inputs or features outside the spec.
- If the environment prevents meaningful review, report that the review is blocked.

Every reviewer checks the public contract, ordinary inputs, mixed separators,
blank input, duplicates after normalization, and preservation of order and
internal text independently.

Reviewers must not edit source, tests, configuration, prompts, or the spec. Put
observations in the review file given in the instructions. Do not create commits.
