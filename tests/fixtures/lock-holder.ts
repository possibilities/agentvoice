import { lockFile, lockThread } from "../../src/core/thread-lock.ts";

if (process.argv[2] === "--file") lockFile(process.argv[3]!, "locked by another process");
else lockThread(process.argv[2]!, process.argv[3]!);
process.stdout.write("locked\n");
setInterval(() => {}, 1_000);
