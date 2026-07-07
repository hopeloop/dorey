type HtmlDocumentProps = {
  artifactId: string;
  html: string;
  enableSelection?: boolean;
  onMouseUp?: () => void;
};

export function HtmlDocument({
  artifactId,
  html,
  enableSelection = false,
  onMouseUp,
}: HtmlDocumentProps) {
  return (
    <div
      className="html-document review-markdown"
      data-block-id={`${artifactId}:html:1`}
      data-selection-enabled={enableSelection ? "true" : "false"}
      onMouseUp={enableSelection ? onMouseUp : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
