import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Guardar en tabla kiosk_logs de Supabase
    const { error } = await supabase
      .from('kiosk_logs')
      .insert({
        timestamp: body.ts,
        pos_id: body.pos,
        event_type: body.event,
        event_data: body,
        created_at: new Date().toISOString()
      });
    
    if (error) throw error;
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Log error:', error);
    return NextResponse.json({ error: 'Failed to log' }, { status: 500 });
  }
}
