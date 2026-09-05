import { lockThread } from "../../src/core/thread-lock.ts";

lockThread(process.argv[2]!, process.argv[3]!);
process.stdout.write("locked\n");
setInterval(() => {}, 1_000);
