# Pinned third-party dependencies

| Module | Repository | Commit |
| --- | --- | --- |
| `github.com/sarchlab/akita/v5` | `git@github.com:sarchlab/akita` | `96b0b168dfa050f616bbda5ab044f3f65b6c9b6a` |
| `github.com/sarchlab/mgpusim/v5` | `git@github.com:sarchlab/mgpusim` | `bfc56c464bc48733f482dddefe98afa3c721eaa8` |

`pins.env` holds the same two values and `scripts/fetch-deps.sh` reads them.
Both live in gitignored `third_party/`.

```bash
make -C simulator deps        # restore
make -C simulator verify-pins # check without modifying
make -C simulator regen-patch # rewrite the mgpusim-*.patch set
```