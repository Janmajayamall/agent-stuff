import unittest

from tags import normalize_tags


class NormalizeTagsTests(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(normalize_tags(""), [])

    def test_ignores_empty_and_whitespace_only_tags(self):
        self.assertEqual(normalize_tags(" , \n,\t,\n "), [])

    def test_accepts_commas_and_newlines_together(self):
        self.assertEqual(normalize_tags("red,green\nblue,yellow"), [
            "red", "green", "blue", "yellow"
        ])

    def test_trims_and_lowercases(self):
        self.assertEqual(normalize_tags(" Python ,\tRUST\n JavaScript "), [
            "python", "rust", "javascript"
        ])

    def test_deduplicates_after_normalization(self):
        self.assertEqual(normalize_tags("Alpha, beta\nALPHA, BETA , gamma"), [
            "alpha", "beta", "gamma"
        ])

    def test_preserves_first_occurrence_order(self):
        self.assertEqual(normalize_tags("zebra,apple,zebra,banana,apple"), [
            "zebra", "apple", "banana"
        ])

    def test_preserves_internal_spaces_and_punctuation(self):
        self.assertEqual(normalize_tags(" Machine  Learning, C++ , a/b "), [
            "machine  learning", "c++", "a/b"
        ])

    def test_accepts_crlf_line_endings(self):
        self.assertEqual(normalize_tags("red\r\ngreen\r\nred"), ["red", "green"])


if __name__ == "__main__":
    unittest.main()
