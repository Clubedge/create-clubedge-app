# Security policy

## Supported versions

Security fixes are made against the latest code on `main`. The CLI does not currently publish versioned releases or promise a support window for old versions.

## Reporting a vulnerability

Do not disclose exploitable vulnerabilities in public issues or pull requests. Use GitHub's **Report a vulnerability** option in the repository's Security tab. If private reporting is unavailable, contact the repository owner through [GitHub](https://github.com/yassine-ahmed) and include safe reproduction steps.

The CLI downloads source code from the configured public Clubedge Starter GitHub repository and may run `pnpm install` in the destination project. Review the selected `--ref` and generated files before running commands or deploying the result. Never pass credentials in command-line arguments or commit them to the generated project.
