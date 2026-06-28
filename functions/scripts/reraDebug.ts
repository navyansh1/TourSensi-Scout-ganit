/** Show cached counts for all states + sample. */
import * as admin from "firebase-admin";
if (!admin.apps.length) admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

(async () => {
  const col = admin.firestore().collection("rera_cache");
  for (const st of ["TN", "KA", "MH", "RJ", "HR"]) {
    const meta = await col.doc(st).get();
    if (!meta.exists) { console.log(`${st}: (not cached)`); continue; }
    const { total = 0, refreshedAt } = meta.data() as any;
    console.log(`${st}: ${total} projects (refreshed ${new Date(refreshedAt).toLocaleDateString()})`);
  }
  process.exit(0);
})();
