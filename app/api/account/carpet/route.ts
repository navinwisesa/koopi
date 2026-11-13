import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { carpetFromMetadata, parseCarpet } from "@/lib/accountCarpet";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Sign in to load your carpet." }, { status: 401 });
    return NextResponse.json({ carpet: carpetFromMetadata(user.user_metadata) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Couldn't load your carpet. Please retry." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Sign in to save your carpet." }, { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid carpet settings." }, { status: 400 }); }
    const carpet = parseCarpet(body);
    if (!carpet) return NextResponse.json({ error: "Use a headline of 1–22 characters and a caption of 1–46 characters." }, { status: 400 });
    // Auth validates the account from its cookie. A caller cannot nominate a
    // different user, and no privileged service key or profile policy is needed.
    const existing = carpetFromMetadata(user.user_metadata);
    const migrate = (body as Record<string, unknown>).migrate === true;
    if (migrate && existing) return NextResponse.json({ carpet: existing });
    const { data, error: saveError } = await supabase.auth.updateUser({ data: { koopi_carpet: carpet } });
    if (saveError || !data.user) return NextResponse.json({ error: "Couldn't save your carpet to your account. Please retry." }, { status: 503 });
    return NextResponse.json({ carpet: carpetFromMetadata(data.user.user_metadata) ?? carpet });
  } catch {
    return NextResponse.json({ error: "Couldn't save your carpet to your account. Please retry." }, { status: 503 });
  }
}
