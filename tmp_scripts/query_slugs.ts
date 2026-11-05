import { createClient } from '@supabase/supabase-js';
const url = process.env.VITE_SUPABASE_URL!;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const supabase = createClient(url, key);
const { data, error } = await supabase.from('strategies').select('slug, suit_name, markets').order('sort_order');
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify(data, null, 2));
