// Usage: node dist/cli/create-user.js <email> <handle> [displayName]
// Password is read from FORGEHUB_NEW_USER_PASSWORD (kept off the command line / shell history).
// Works regardless of FORGEHUB_REGISTRATION, so it is the admin path when sign-up is closed.
import { prisma } from "../prisma.js";
import { registerBodySchema } from "../validation.js";
import { createUserAccount } from "../user-service.js";

async function main(): Promise<number> {
  const [email, handle, displayName] = process.argv.slice(2);
  const password = process.env["FORGEHUB_NEW_USER_PASSWORD"];
  if (!email || !handle || !password) {
    console.error("Usage: FORGEHUB_NEW_USER_PASSWORD=... node dist/cli/create-user.js <email> <handle> [displayName]");
    return 2;
  }
  const parsed = registerBodySchema.safeParse({ email, handle, password, displayName });
  if (!parsed.success) {
    console.error("Invalid input:", JSON.stringify(parsed.error.flatten().fieldErrors));
    return 2;
  }
  const user = await createUserAccount(parsed.data);
  if (!user) {
    console.error("Email or handle already taken");
    return 1;
  }
  console.log(`Created user @${user.handle} (${user.email})`);
  return 0;
}

main()
  .then((code) => prisma.$disconnect().finally(() => process.exit(code)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
