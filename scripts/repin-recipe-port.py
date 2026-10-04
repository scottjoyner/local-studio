"""Copy a recipe with its port re-pinned, for acceptance runs on a busy host."""
import json
import sys


def main() -> int:
    src, dst, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
    recipe = json.load(open(src))
    if recipe.get("port") != port:
        recipe["port"] = port
    json.dump(recipe, open(dst, "w"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
