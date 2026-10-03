def normalize_tags(text: str) -> list[str]:
    """Read a comma-separated tag list."""
    return [part.strip() for part in text.split(",") if part.strip()]
