# Retrieve Checker 
SP Retrieval Checker Module for retroacive SLA using checker network through smart contracts.

## Development

Install [Zinnia CLI](https://github.com/filecoin-station/zinnia).

```bash
$ # Lint
$ npx standard
$ # Run module
$ zinnia run main.js
$ # Test module
$ zinnia run test.js
```

## Release

On a clean working tree, run the following command:

```bash
$ ./release.sh <semver>
$ # Example
$ ./release.sh 1.0.0
```

Use GitHub's changelog feature to fill out the release notes.

Publish the new release and let the CI/CD workflow upload the sources
to IPFS & IPNS.
