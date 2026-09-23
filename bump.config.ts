import { defineConfig } from "bumpp";

export default defineConfig({
  push: false,
  pr: {
    branch: "release/v{version}", // release branch name template
    base: "main", // PR base branch (defaults to origin/HEAD)
    title: "chore: release {tag}", // defaults to the release commit message
    body: "{oldVersion} → {version}", // template string, or a function receiving the tokens
    draft: false, // open the PR as a draft
  },
});
