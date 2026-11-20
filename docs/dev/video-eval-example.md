# Video evaluation table example

All values below are synthetic. They do not come from a model run.

| Row | Arm | Level | Route | Seed | Steps / schedule | Adapter | Wall ms | Peak bytes | Requested | Native | Delivered | Finish | Checker | Refusal | Identity | Skin | Movement | Composition | Speech | Notes |
|---|---|---|---|---:|---|---|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|
| sage-ltx-standard-1 | LTX Standard | standard | words | 4101 | 24 / linear | | 96000 | 12000000000 | 768x512 | 768x512 | 768x512 | mux:true | pass | | 4 | 4 | 3 | 5 | 4 | Clear window light |

Minutes per accepted take: 1.600
First-take pass rate: 100.0% (1/1)

## Synthetic delta table

| Row | Wall change | Peak change | Verdict |
|---|---:|---:|---|
| sage-ltx-standard-1 | -12.0% | 5.0% | fail → pass |
