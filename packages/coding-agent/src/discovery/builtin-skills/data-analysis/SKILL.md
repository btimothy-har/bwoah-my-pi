---
name: data-analysis
description: "Analysis guidance for statistical study design, exploratory queries, metric investigation, cohort analysis, experiment review, anomaly investigation, and evidence-based recommendations. Keywords: data analysis, research, queries, metrics, cohorts, population, experiment, hypothesis, evidence."
---

# Data Analysis and Research

Answer questions with evidence. Treat non-trivial analysis like a study: define the population, unit, measures, comparison groups, method, and limits before trusting the result.

## When to Use

Apply this skill to:
- exploratory data analysis
- metric, dashboard, or anomaly investigation
- cohort, funnel, retention, revenue, or usage analysis
- group comparisons and statistical studies
- experiment or A/B test interpretation
- query-driven research
- code, log, or document research where the output is findings
- evidence-based recommendations

When the work also involves SQL, Python, notebooks, or warehouse models, load the matching skill if one is available in this session and its guidance is not already in context.

## Principles

**Question before query** — State the question, decision, and expected evidence before pulling data.

**Population before comparison** — Define the eligible base population first. Groups A and B must be drawn from the same population unless the difference is intentional and disclosed.

**Unit before metrics** — Choose the unit of analysis: user, account, session, order, event, day, etc. Metrics and joins must preserve that unit or intentionally aggregate to it.

**Exposure before outcome** — Define group assignment, treatment, segment, or event exposure before measuring outcomes. Avoid using future information or post-outcome attributes to define cohorts.

**Joins before conclusions** — Attribute joins can change the study population. Validate cardinality, unmatched rows, duplicates, and missing attributes before interpreting metrics.

**Denominators before rates** — Every rate, average, or lift number needs its denominator. Comparisons need consistent eligibility, filters, and observation windows.

**Uncertainty before recommendation** — Report effect size with enough context to judge confidence: sample size, variance, confidence intervals, sensitivity checks, or clear qualitative caveats.

## Process

### 1. Frame

Clarify:
- question or hypothesis
- decision this informs
- target population or system scope
- outcome of interest
- comparison of interest, if any
- time window
- required confidence level
- expected deliverable

If the question is broad, split it. If the decision is unclear, ask before analyzing.

### 2. Define the Study Design

Before writing the main query, define:
- **base population** — who or what is eligible
- **unit of analysis** — one row per what
- **cohort entry** — when an entity becomes eligible
- **observation window** — when outcomes are measured
- **exclusions** — what is removed and why
- **groups/exposures** — how A/B, treatment/control, or segments are assigned
- **outcomes** — what is measured
- **attributes/covariates** — what needs to be joined in

For comparisons, confirm groups come from the same base population and use the same outcome window. If they do not, the analysis is descriptive, not a clean comparison.

### 3. Inventory Sources

Identify available evidence:
- tables, files, APIs, logs, docs, or code paths
- schema, columns, and source grain
- existing metric definitions or dashboard logic
- event timestamps and lifecycle states
- prior analyses or decisions
- known data quality issues

Do not infer semantics from names alone. Inspect schemas, samples, docs, or existing usage.

### 4. Plan Complex Analysis

For complex analysis or research, plan the work before execution. The plan should cover:
- question and decision
- base population and unit of analysis
- source tables/files/docs
- group, exposure, outcome, and attribute definitions
- join strategy and validation checks
- comparison or statistical method
- success criteria
- assumptions and boundaries
- ordered tasks

For small questions, proceed directly; add explicit tracking only when it helps preserve state or sequence.

### 5. Build the Analytical Dataset

Start from the base population, then add attributes and outcomes deliberately.

Validate each major step:
- row counts before and after joins
- one row per unit of analysis
- duplicate keys
- unmatched join rates
- null rates for important attributes
- date ranges and timestamp alignment
- group assignment coverage
- outcome availability

For group comparisons, produce group counts from the same dataset used for outcomes. Do not compare metrics built from different filtered populations unless that is the point of the analysis.

### 6. Explore and Compare

Start with source sanity checks:
- distributions
- outliers
- missingness
- baseline group balance
- segment sizes
- denominator consistency

Then answer the question with focused queries, scripts, or searches.

Choose the comparison method to match the design:
- randomized experiment: compare assigned groups, preserve assignment, report sample sizes and uncertainty
- observational cohort: check confounding, baseline imbalance, and time-ordering before implying causality
- before/after: account for seasonality, trend, and cohort composition changes
- descriptive analysis: avoid causal language

Prefer simple, inspectable calculations before complex models.

### 7. Validate and Stress-Test

Before concluding:
- reconcile against source totals or known benchmarks
- test important filters, joins, and cohort definitions
- rerun with alternate reasonable windows or exclusions
- inspect outliers and missingness
- check whether assumptions change the answer
- compare against dashboard or existing metric definitions when relevant
- distinguish correlation from causation

Surprising results need extra skepticism. Check data quality and query logic before treating them as real.

### 8. Synthesize

Lead with the answer, then support it.

Include:
- direct answer to the question
- base population, unit of analysis, and time window
- group/exposure and outcome definitions
- denominators and sample sizes
- key evidence and method
- effect size and confidence level
- assumptions and limitations
- unresolved questions
- recommended next steps

Use tables, bullets, or short query excerpts when they clarify the evidence. Do not bury the conclusion under raw query output.

## Output Expectations

A good analysis result makes it easy to see:
- what question was answered
- who or what was included
- whether compared groups came from the same population
- how attributes and outcomes were joined
- what evidence supports the answer
- how much confidence to place in it
- what remains unknown
- what should happen next, if anything

If findings imply code, configuration, docs, or product changes, recommend planning that change rather than jumping straight to implementation.

## Anti-Patterns

- Starting with a query before framing the question
- Comparing A vs B from different base populations
- Changing denominators between related metrics
- Joining attributes after filtering in a way that silently drops entities
- Ignoring join cardinality, duplicate keys, or unmatched rows
- Defining cohorts using information that occurs after the outcome window starts
- Treating observational comparisons as causal without justification
- Reporting lift without sample sizes or uncertainty
- Treating dashboard numbers as truth without checking definitions
- Hiding uncertainty to make a conclusion sound stronger
- Turning findings directly into implementation without planning
