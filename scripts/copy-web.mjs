import { cpSync } from "node:fs";
cpSync(
  new URL("../src/web/public", import.meta.url),
  new URL("../dist/src/web/public", import.meta.url),
  { recursive: true },
);
