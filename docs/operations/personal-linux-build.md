# Personal Linux Nightly

The `personal` branch carries local customizations on top of an official Nightly
tag. `origin` points to the personal fork; `upstream` points to `pingdotgg/t3code`.

Use Node 24 and the pnpm version pinned in `package.json`. Install dependencies
with `pnpm install --frozen-lockfile`, then build:

```bash
bash scripts/build-personal-linux.sh
```

The AppImage is written to `release/personal`. The version defaults to the nearest
official Nightly tag. Personal builds intentionally omit an automatic update feed:
installing an official update would replace the OMP integration.

To incorporate another official Nightly, commit pending work, fetch its tag from
`upstream`, and merge that tag into `personal`. Resolve conflicts and run the
focused OMP tests before building and replacing the installed AppImage:

```bash
pnpm exec vp test run apps/server/src/provider/Drivers/OmpDriver.test.ts apps/server/src/provider/Layers/OmpProvider.test.ts
```

For a real OMP session test, set `T3_OMP_SMOKE_BINARY` to the installed OMP
executable and `T3_OMP_SMOKE_MODEL` to a model selector reported by `omp models`.
The test sends one short prompt through the orchestration adapter using the
locally configured model credentials.
