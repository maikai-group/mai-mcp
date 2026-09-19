### Receiving a finding

**Verify the premise before acting on it.** Current source and governing requirements decide whether the finding is real. A persuasive review is evidence to evaluate, not authority to change the design.

Authority order: explicit current user decision; approved governing spec/recorded decision; actual code/schema/tool interfaces; plan prose; reviewer suggestion. Surface consequential conflicts.

### Repair the defect family

Search for the relevant defect shape and inspect matching sites, including its producer or generator. A targeted mechanical search across an artifact is not a mandate to reread the whole artifact. Record the search and affected sites in the existing finding note; merge duplicate repair work while preserving finding UUIDs.

Check the changed end state and affected contracts. Re-read all citations belonging to the finding. Check heading ownership, counts or ordering only if the repair affects them. Cosmetic wording corrections need a diff and consistency check; substantive changes need evidence proportional to their effects.

### Evidence and limits

Use existing trustworthy verification when command, relevant inputs, configuration/toolchain and environment match. Missing metadata invalidates only the affected check. Record what ran, what was reused, and what remains unknown in the existing closure note; no separate repair-shadow receipt is required.

For executable behavior, run the relevant regression when valid evidence is absent. Demonstrate red/green or mutation behavior when needed to establish that a discriminator catches the defect; do not require a new mutation exercise for every repair. Plan prose is normally checked by source/contract inspection, with focused scratch probes for consequential uncertainty. Full implementation verification belongs to execution.

When no executable gate covers a claim, state "Verified by source inspection" with the inspected boundary; never imply a test ran. A genuine approval-critical uncertainty remains open. Before a repair that requires a new product/policy decision, raise that decision; routine corrections within current authority proceed.
