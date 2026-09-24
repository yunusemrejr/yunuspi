---
id: dataviz
part: design
title: Data visualization
summary: Charts that tell the truth quickly: choosing the chart for the question, the encoding hierarchy, honest axes, annotation, small multiples, color for data, and dashboards that answer decisions.
terms: chart charts graph graphs plot plots visualization visualize dataviz dashboard bar line scatter pie donut histogram heatmap axis axes legend label annotation d3 chartjs recharts plotly matplotlib vega kpi metric
tools: render_see design_audit
skills: data-viz statistical-experiments color-theory
---

# Data visualization

A chart is an argument made with geometry. It should answer one question faster and more reliably than a table could. Misleading charts are rarely malicious; they are usually the default output of a tool applied without thought.

## Start from the question {#question}
<!-- terms: question insight purpose message decision audience compare trend distribution relationship composition -->

**Principle.** Decide what question the chart answers—comparison, trend, distribution, relationship or composition—then choose the form that answers it best.

**Why.** Charts made to "show the data" show nothing in particular. Comparisons across categories want sorted bars; trends over time want lines; distributions want histograms or box plots; relationships want scatter plots; composition over few parts may want stacked bars. Titling the chart with its takeaway ("Signups doubled after the redesign") forces clarity about the question.

**Signals.** Charts titled with variable names only; chart types chosen for novelty; several questions crammed into one chart.

**Ask.** What single question does this chart answer, and would its title state the answer?

**Traps.** Takeaway titles that overstate what the data shows.

## Use the most accurate encoding available {#encoding}
<!-- terms: encoding position length angle area color hue perception accuracy bar pie cleveland -->

**Principle.** Encode the most important comparison with position on a common scale, then length; use angle, area and color intensity only for secondary information.

**Why.** Perception research (Cleveland and McGill) ranks accuracy: position along a common scale beats length, which beats angle and area, which beat color intensity. That is why sorted bar charts beat pie charts for comparing values, and why bubble sizes mislead. Aligning comparisons to a shared baseline makes differences instantly visible.

**Signals.** Pie charts with many slices; bubble charts for precise comparison; 3D charts distorting length.

**Ask.** Is the key comparison encoded by position on a shared scale?

**Traps.** Rejecting a pie chart for a simple two-part share where it communicates fine.

## Axes must not lie {#honest-axes}
<!-- terms: axis zero baseline truncated scale log dual axis misleading aspect ratio -->

**Principle.** Bar charts start at zero; line charts may zoom but must label their range clearly; avoid dual axes that manufacture correlations; use log scales only when labeled and justified.

**Why.** Bars encode value by length, so a truncated baseline exaggerates differences dramatically. Dual-axis charts let anyone make two series appear correlated by choosing scales. Aspect ratio changes the perceived steepness of trends. Honest charts make the scale obvious and choose it for the data, not for the story.

**Signals.** Bars starting above zero; two y-axes with independent scales; unlabeled log scales.

**Ask.** Would a reader misjudge the size of this difference because of the axis choice?

**Traps.** Forcing zero on line charts where variation near a high value is the point.

## Annotate the insight {#annotation}
<!-- terms: annotation label direct labeling legend callout highlight context reference line -->

**Principle.** Label data directly, highlight what matters and add context—targets, events, benchmarks—so readers do not decode legends.

**Why.** Legends force eye movement back and forth; direct labels on lines and bars remove it. Highlighting the series that matters (and graying the rest) tells readers where to look. Annotations for events ("pricing change") and reference lines ("target") turn a picture into an explanation.

**Signals.** Legends with many entries; all series in equally strong colors; no context for spikes or drops.

**Ask.** Could a reader understand the point of this chart without reading the legend?

**Traps.** Annotating so much that the data disappears.

## Small multiples beat spaghetti {#small-multiples}
<!-- terms: small multiples facet trellis grid panels many series spaghetti overlapping lines -->

**Principle.** When comparing many series, draw a grid of small charts with shared scales instead of overlaying everything in one chart.

**Why.** More than about five overlapping lines become unreadable spaghetti. Small multiples let the eye compare shapes across panels while each stays legible. Shared axes are essential: independent scales make every panel look similar and hide real differences.

**Signals.** Line charts with many overlapping series; stacked areas with many layers; per-panel scales that differ.

**Ask.** Would splitting this into small multiples with shared scales make the comparison clearer?

**Traps.** So many panels that each is too small to read.

## Dashboards answer decisions {#dashboards}
<!-- terms: dashboard kpi metrics monitoring decision alert overview drill down vanity -->

**Principle.** Every dashboard element should support a decision or action; lead with the few metrics that matter, with context and thresholds.

**Why.** Dashboards often become walls of equally weighted numbers nobody acts on. A useful dashboard states what "good" looks like (targets, previous period, thresholds), surfaces anomalies first, and lets users drill into causes. Vanity metrics that only go up distract from actionable ones.

**Signals.** Dashboards with dozens of tiles of equal weight; numbers without comparison or target; metrics nobody can act on.

**Ask.** What decision would change based on each number on this dashboard?

**Traps.** Real-time updating for metrics reviewed weekly.
