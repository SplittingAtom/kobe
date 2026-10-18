-- KOBE-276 review N1: validate orbit_evals_cases (added NOT VALID in 0113). Custom, so db:rebase
-- keeps this SQL as written. Every row satisfies it (rows from before KOBE-276 have no cases);
-- VALIDATE takes SHARE UPDATE EXCLUSIVE and scans orbit_evals once, so writes go on meanwhile.
ALTER TABLE "orbit_evals" VALIDATE CONSTRAINT "orbit_evals_cases";
