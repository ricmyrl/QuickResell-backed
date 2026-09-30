export interface HeapItem<T = any> {
  score: number;
  data: T;
}

export class MinHeap {
  private heap: HeapItem[] = [];
  private capacity: number;

  constructor(capacity: number = 20) {
    this.capacity = capacity;
  }

  // Get current size of the heap
  size(): number {
    return this.heap.length;
  }

  // Insert a new item into the heap
  insert(score: number, data: any): void {
    const node: HeapItem = { score, data };

    // If we haven't reached capacity, just add and bubble up
    if (this.heap.length < this.capacity) {
      this.heap.push(node);
      this.bubbleUp(this.heap.length - 1);
    } 
    // If at capacity, only insert if the new score is higher than the lowest score (root)
    else if (score > this.heap[0].score) {
      this.heap[0] = node;
      this.bubbleDown(0);
    }
  }

  // Extract all elements sorted from highest to lowest score
  getSortedTopElements(): HeapItem[] {
    // Copy and sort descending for final output
    return [...this.heap].sort((a, b) => b.score - a.score);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[index].score >= this.heap[parentIndex].score) break;

      // Swap
      [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
      index = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let leftChild = 2 * index + 1;
      let rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.heap[leftChild].score < this.heap[smallest].score) {
        smallest = leftChild;
      }
      if (rightChild < length && this.heap[rightChild].score < this.heap[smallest].score) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      // Swap
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}