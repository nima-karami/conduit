---
title: Fidelity CRLF
---

# Fidelity CRLF

An ingest pipeline, hand-written the way an agent would: comments, a chain, text-form edge labels,
a cylinder, a subgraph and styling below the graph.

~~~mermaid
flowchart LR
    %% ingest pipeline
    src[Source] --> parse[Parse] --> enrich(Enrich) --> sink
    parse -- batch --> db[(Store)]
    subgraph workers [Workers]
        w1[Worker one]
        w2{{Worker two}}
    end
    %% wiring
    enrich --> w1
    w1 -.-> w2
    classDef hot fill:#f96
    class src,db hot
    linkStyle 1 stroke:#0a0
~~~

Nothing after the diagram changes either.
