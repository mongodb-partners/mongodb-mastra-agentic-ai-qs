# Marshal documentation

Start with whichever of these matches what you are doing.

## Learn

| Document | For |
|---|---|
| [getting-started.md](getting-started.md) | Standing it up on your own cluster and watching one investigation run |
| [architecture.md](architecture.md) | The C4 diagrams, the pipeline sequence, and where the time goes |
| [mongodb-capabilities.md](mongodb-capabilities.md) | Each Atlas capability, the pipeline that uses it, and what it measured |
| [adr/](adr/README.md) | Ten decisions where the obvious choice was not the one taken |

## Look up

| Document | For |
|---|---|
| [api-reference.md](api-reference.md) | All 15 endpoints, their payloads, and every error case |
| [data-model.md](data-model.md) | Collections, fields, indexes, money, embeddings |
| [configuration.md](configuration.md) | Every environment variable, its default, and what breaks without it |

## Do

| Document | For |
|---|---|
| [operations.md](operations.md) | Every script, the replay lifecycle, benchmarking, troubleshooting |
| [developer-guide.md](developer-guide.md) | Repository layout, tests, extension points, conventions |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Opening a pull request |
| [../deploy/README.md](../deploy/README.md) | Terraform deployment to AWS and Atlas |

## A note on the numbers

Every measurement in these documents states the corpus size it was taken at, and latency figures state
the Atlas tier. Both matter more than they look: an 83x larger corpus costs 5.0x the median on the hybrid
retrieval leg, and adding a second 1M-document vector index to one M30 moved an untouched index's p50
from 21.0 to 179.6 ms. Figures without that context are not checkable, so they are not quoted here.
