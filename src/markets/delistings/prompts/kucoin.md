## Configuration

**Exchange:** Kucoin
**Action Type:** Delisting
**Target Trading Pairs:** Perpetual Contract (USDT pairs)
**Announcements URL:** https://www.kucoin.com/announcement/delistings/page/1
**Date Range:** 01 January 2025 - 01 April 2026
**Pagination Start:** Page 1 (including)
**Pagination Stop:** Page 6 (including)
**Output Path:** ./src/markets/delistings/kucoin.json

---

## Task Overview

I need you to extract information about the specified **Action Type** for the specified **Target Trading Pairs** from the **Exchange's** announcement page, focusing on **Action Type** within the specified **Date Range**.

**IMPORTANT:** Use Playwright browser automation tools directly - do NOT build or create any scripts. Use the available Playwright tools to navigate, interact with, and extract data from web pages directly.

## Detailed Instructions

1. **Navigate to the announcement list page** at the URL specified in the configuration
   - **START** processing from the page number specified in **Pagination Start** (including that page)
   - Process pages in order from **Pagination Start**, moving to subsequent pages sequentially
   - Do not process the same page twice - keep track of which pages have been processed

2. **Filter announcements by title:**
   - Process announcements in chronological order (top-to-bottom on each page, from newest to oldest)
   - Do not process the same announcement twice - keep track of which announcements have been processed
   - Look for announcements about the **Action Type** specified in the configuration
   - **Skip announcements ONLY if** the title clearly indicates a DIFFERENT trading pair type than **Target Trading Pairs**:
     - If targeting Futures/Perpetual contracts → Skip titles containing "Spot", "Margin", "Alpha", "Collateral", "Lending"
     - If targeting Spot → Skip titles containing "Futures", "Perpetual", "Alpha"
     - etc.
   - **MUST investigate announcements** if:
     - Title explicitly mentions the **Target Trading Pairs** type → Always open
     - Title is a general announcement (e.g., "[Exchange] Will Delist X, Y, Z on DATE") → Always open, as these often contain multiple sections for different trading pair types
     - Title doesn't clearly indicate the trading pair type → Always open
   - Focus only on announcements within the **Date Range** specified in the configuration
   - **START** processing from the page number specified in **Pagination Start** (including that page) - skip pages before this
   - **STOP** when you reach the page number specified in **Pagination Stop** (including that page) - do not process any further pages

3. **Process announcements one by one:**
   - Process announcements in chronological order (top-to-bottom, from newest to oldest)
   - Do not process the same announcement link twice - skip if already processed
   - Open each announcement link individually before moving to the next
   - For each announcement, look for a section matching the **Target Trading Pairs** (e.g., "Futures" section for perpetual contracts)
   - General announcements often have multiple sections (Spot, Futures, Margin, etc.) - extract data ONLY from the section matching **Target Trading Pairs**
   - Extract the token names in the format matching **Target Trading Pairs** (e.g., append "USDT" for USDT pairs)
   - Extract the action datetime in UTC format from the relevant section

4. **Output format:**
   Create a JSON object with token names as keys and action datetimes as values:

```json
{
  "TOKENUSDT": "YYYY-MM-DD HH:MM",
  "TOKENUSDT": "YYYY-MM-DD HH:MM"
}
```

1. **Save the results:**
   - Save the JSON output to the path specified in the configuration
   - Ensure the file is properly formatted and valid JSON

## Important Notes

- **Do NOT build or create any scripts** - use Playwright browser automation tools directly to interact with web pages
- Only include data matching **Target Trading Pairs** from the configuration
- Only include announcements matching **Action Type** from the configuration
- Skip announcements clearly marked as different trading pair types - but always investigate general/ambiguous announcements
- Only include tokens within the **Date Range** from the configuration
- Use UTC timezone for all datetimes
- Format datetime as "YYYY-MM-DD HH:MM"
- Process announcements one by one in chronological order (top-to-bottom, from newest to oldest)
  - **START** processing from the page number specified in **Pagination Start** (including that page) - skip pages before this
  - **STOP** when you reach the page number specified in **Pagination Stop** (including that page) - do not process any further pages
  - Do not process the same announcement or page twice - keep track of processed items
- Save output to **Output Path** from the configuration

Please proceed with this task and save the complete JSON output to the specified path when finished. Start processing from the page specified in **Pagination Start** (including that page) and stop processing when you reach the page specified in **Pagination Stop** (including that page).

---
