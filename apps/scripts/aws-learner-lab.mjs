#!/usr/bin/env node
import { runLearnerLabKubernetes } from "./lib/learner-lab-kubernetes-runtime.mjs";

const result = await runLearnerLabKubernetes({ argv: process.argv.slice(2) });
process.exitCode = result.status;
