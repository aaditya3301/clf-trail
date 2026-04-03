"""
bulk_insert.py — Automates inserting multiple leads into a site using Playwright.
Reads site configuration from site_context.json.
Reads lead data from leads_to_insert.json.
"""

import json
import time
from playwright.sync_api import sync_playwright

def load_json(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)

def run_bulk_insert():
    context_data = load_json("site_context.json")
    leads_data = load_json("leads_to_insert.json")
    
    url = context_data["target_url"]
    locators = context_data["locators"]
    fields = context_data["fields"]
    
    print(f"🚀 Starting bulk insertion of {len(leads_data)} leads to {url}\n")
    
    with sync_playwright() as pw:
        # Launch visible browser
        browser = pw.chromium.launch(headless=False, args=["--no-sandbox"])
        
        # Open page
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()
        
        print("🌐 Navigating to site...")
        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        
        # Ensure we accept any unexpected dialogs (like alerts)
        page.on("dialog", lambda dialog: dialog.accept())
        
        success_count = 0
        
        for idx, lead in enumerate(leads_data, start=1):
            print(f"\n--- Inserting Lead {idx}/{len(leads_data)}: {lead.get('name', 'Unknown')} ---")
            
            try:
                # 1. Click 'Add Manually' or open modal button
                open_btn = page.locator(locators["open_modal_button"]).first
                if open_btn.is_visible(timeout=5000):
                    open_btn.click()
                    print("✅ Clicked Open Modal button")
                else:
                    # Generic fallback if exact locator fails
                    page.get_by_text("Add Manually", exact=False).first.click()
                    print("⚠️ Clicked 'Add Manually' using text fallback")
                
                page.wait_for_timeout(1000)
                
                # 2. Fill the fields based on context mapping
                for field_map in fields:
                    key = field_map["key"]
                    locator_str = field_map["locator"]
                    
                    if key in lead:
                        value = str(lead[key])
                        try:
                            field_elem = page.locator(locator_str).first
                            field_elem.fill(value)
                            print(f"📝 Filled {key}: {value}")
                        except Exception as e:
                            print(f"❌ Failed to fill {key} using locator '{locator_str}': {e}")
                
                page.wait_for_timeout(500)
                
                # 3. Click Submit
                submit_btn = page.locator(locators["submit_button"]).first
                if submit_btn.is_visible(timeout=3000):
                    submit_btn.click()
                    print("✅ Clicked Submit button")
                else:
                    page.locator("button", has_text="Add").first.click()
                    print("⚠️ Clicked Submit fallback")
                    
                page.wait_for_timeout(1000)
                
                # 4. Handle OK Modal (if it exists)
                ok_btn = page.locator(locators["ok_button"]).first
                if ok_btn.is_visible(timeout=2000):
                    ok_btn.click()
                    print("✅ Clicked OK modal")
                
                # 5. Wait for Lead to register and Modal to close
                page.wait_for_timeout(2000)
                success_count += 1
                
            except Exception as e:
                print(f"🚨 Error processing lead {lead.get('email')}: {e}")
                
            # Wait a moment before inserting the next one
            time.sleep(1)
            
        print(f"\n🎉 Finished bulk processing! Successfully processed {success_count}/{len(leads_data)} leads.")
        
        browser.close()

if __name__ == "__main__":
    try:
        run_bulk_insert()
    except KeyboardInterrupt:
        print("\n🛑 Process interrupted by user.")
    except Exception as e:
        print(f"\n🚨 Fatal error: {e}")
