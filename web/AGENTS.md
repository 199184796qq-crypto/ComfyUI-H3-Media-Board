# Node UI sizing

- Keep list nodes compact and automatically fit their visible rows when items are added or removed.
- For DOM widgets, reserve the content height plus both outer widget margins. ComfyUI subtracts those margins from the element's available height.
- Include row gaps, header height, and content padding. Use the same total height for minimum, maximum, and preferred widget height when the list should fit its content exactly.
- Let the node's layout calculate socket and widget placement. Do not derive total height from stale `last_y` or stretched DOM container measurements.
- Verify that the final row remains fully visible when the list grows and shrinks; syntax or mocked layout tests alone do not establish visual correctness.
