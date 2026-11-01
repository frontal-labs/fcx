import { meta } from "./meta.js";
const cmd = process.argv[2];
if (cmd === "--version" || cmd === "-v") {
  console.log(meta.version);
  process.exit(0);
}
if (cmd === "status") {
  console.log(JSON.stringify({ status: "ok", binary: meta.binary }));
  process.exit(0);
}
if (cmd === "doctor") {
  console.log(JSON.stringify({ status: "ok" }));
  process.exit(0);
}
console.log(meta.binary + " " + meta.version);
