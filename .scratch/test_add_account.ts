import { ContentCreator } from "#core/contentCreator";
import { Account } from "#core/account";
import { randomID } from "#core/db";

const cc = await ContentCreator.load("3ab422e2-d93b-4a39-a1eb-eb9df01e101b");
if (!cc) throw new Error("no cc");
console.log("Loaded CC:", cc.id, cc.state);

const newAccount = await Account.load(randomID());
if (!newAccount) throw new Error("Failed to create new Account");
console.log("Created account:", newAccount.id);
await newAccount.setPlatform("youtube");
console.log("Set platform");
await cc.addAccount(newAccount);
console.log("Added account to CC. accounts count:", cc.accounts.length);
process.exit(0);
