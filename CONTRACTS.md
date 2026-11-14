# Stage 3 — assignment and result contracts

- [x] Optional bounded assignment contract. `subagent.assignmentContract` supplies objective, scope, criteria (`criterionId`, `text`), dependencies, inputs, files, decisions and changeConstraints. With `planTask`, objective/scope/criteria/dependencies/inputs are derived from the existing task (artifact refs are inputs); supplied values must agree exactly. Supplemental constraints are caller-owned. Limits: 100 items per list and 8192 characters per nonempty field. Metadata is saved in the launch profile, runtime manifest profile and assignment card. The contract is also included once in the actual model task; the card is display-only. Unbound plain tasks are unchanged.
- [ ] Optional structured per-turn result.
- [ ] Parent-validated criterion evidence and explicit acceptance.
- [ ] Legacy and malformed optional-result compatibility.
