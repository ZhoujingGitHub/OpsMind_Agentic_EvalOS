import { Workbench } from "../../workbench-client";
export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  return <Workbench view="experiment" id={(await params).id} />;
}
