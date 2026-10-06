// Injected by Vite's `define` in vite.config.ts, from the resolved VITE_BASE_PATH
// and VITE_DRIVER_ENCODING. They must match the URLs scripts/prepare-assets.mjs
// writes into public/toolchain/manifest.json (checked in assetCache.ts).
//
// The two maps are keyed by toolchain id, not written out once, because the site
// stages one driver and one archive per row of toolchain/toolchains.json. A
// device names its toolchain id (the simulator's catalog says so), and that id
// picks the pair this run fetches. An id with no entry here is a build that
// cannot serve that device, which assetCache.ts reports rather than guessing at.
declare const __HIPY_TOOLCHAIN_DRIVER_URLS__: Readonly<Record<string, string>>;
declare const __HIPY_TOOLCHAIN_ARCHIVE_URLS__: Readonly<Record<string, string>>;
declare const __HIPY_TOOLCHAIN_MANIFEST_URL__: string;