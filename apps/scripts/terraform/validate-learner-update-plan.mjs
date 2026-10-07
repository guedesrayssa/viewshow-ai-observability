// All Kubernetes updates use the same data-preserving plan gate.
import { main } from "./validate-create-plan.mjs";
main([...process.argv.slice(2), "--update"]);
