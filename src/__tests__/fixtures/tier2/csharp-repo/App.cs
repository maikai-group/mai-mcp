using System;
using Alias = System.Text;

namespace Probe {
    public class App {
        public void Boot() {
            Step();
        }

        private void Step() {}
    }

    public interface IRenderer {
        void Render();
    }
}
