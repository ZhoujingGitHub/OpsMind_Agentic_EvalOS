import { Workbench } from "../../workbench-client";
export default async function TrialPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ analysis?: string }>;
}) {
  return <Workbench view="trial" id={(await params).id} analysisId={(await searchParams).analysis} />;
}
