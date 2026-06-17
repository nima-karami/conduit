# Rich content test fixture

## Valid mermaid diagram

```mermaid
graph LR
  A[Start] --> B[End]
```

## Broken mermaid diagram

```mermaid
not valid mermaid syntax !@#$%
```

## Regular code block (should still highlight)

```typescript
const x: number = 42;
```
