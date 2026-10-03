# Normalize tags

Update the existing `normalize_tags(text: str) -> list[str]` function in `tags.py`.

The function must:

1. Split input at commas and newline characters. Either delimiter may appear anywhere.
2. Strip leading and trailing whitespace from each part.
3. Lowercase each remaining tag with Python's normal string lowercase behavior.
4. Discard empty tags.
5. Remove duplicate normalized tags, retaining the order of their first occurrence.
6. Preserve internal spaces and punctuation.

For example, `" Python, RUST\npython, C++ "` produces
`["python", "rust", "c++"]`. Empty input produces `[]`.

Keep the public function name and signature. Use the Python standard library only.
The input contract is a string; support for other input types is outside scope.
This is a small local exercise. It requires no network access, cloud resources,
package installation, or changes outside this example checkout.

Run `python3 -m unittest -v` to verify the result. The existing tests describe
required behavior; add a focused test only if it covers a meaningful missing case.
